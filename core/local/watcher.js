/* @flow */

import Promise from 'bluebird'
import chokidar from 'chokidar'
import fs from 'fs-extra'
import path from 'path'

import analysis from './analysis'
import * as checksumer from './checksumer'
import * as chokidarEvent from './chokidar_event'
import LocalEventBuffer from './event_buffer'
import logger from '../logger'
import * as metadata from '../metadata'
import Pouch from '../pouch'
import Prep from '../prep'

import type { Checksumer } from './checksumer'
import type { ChokidarEvent } from './chokidar_event'
import type { LocalEvent } from './event'
import type { LocalChange } from './change'
import type { Metadata } from '../metadata'
import type { Pending } from '../utils/pending' // eslint-disable-line
import type EventEmitter from 'events'

const log = logger({
  component: 'LocalWatcher'
})
log.chokidar = log.child({
  component: 'Chokidar'
})

const SIDE = 'local'

type InitialScan = {
  ids: string[],
  resolve: () => void
}

// This file contains the filesystem watcher that will trigger operations when
// a file or a folder is added/removed/changed locally.
// Operations will be added to the a common operation queue along with the
// remote operations triggered by the remoteEventWatcher.
class LocalWatcher {
  syncPath: string
  prep: Prep
  pouch: Pouch
  events: EventEmitter
  initialScan: ?InitialScan
  checksumer: Checksumer
  watcher: any // chokidar
  buffer: LocalEventBuffer<ChokidarEvent>
  ensureDirInterval: *
  pendingChanges: LocalChange[]

  constructor (syncPath: string, prep: Prep, pouch: Pouch, events: EventEmitter) {
    this.syncPath = syncPath
    this.prep = prep
    this.pouch = pouch
    this.events = events
     // TODO: Read from config
    const timeoutInMs = process.env.NODE_ENV === 'test' ? 1000 : 10000
    this.buffer = new LocalEventBuffer(timeoutInMs, this.onFlush)
    this.checksumer = checksumer.init()
    this.pendingChanges = []
  }

  ensureDirSync () {
    // This code is duplicated in local/index#start
    if (!fs.existsSync(this.syncPath)) {
      this.events.emit('syncdir-unlinked')
      throw new Error('Syncdir has been unlinked')
    }
  }

  // Start chokidar, the filesystem watcher
  // https://github.com/paulmillr/chokidar
  start () {
    log.debug('Starting...')

    this.ensureDirInterval = setInterval(this.ensureDirSync.bind(this), 5000)

    this.watcher = chokidar.watch('.', {
      // Let paths in events be relative to this base path
      cwd: this.syncPath,
      // Ignore our own .system-tmp-cozy-drive directory
      ignored: /(^|[\/\\])\.system-tmp-cozy-drive/, // eslint-disable-line no-useless-escape
      // Don't follow symlinks
      followSymlinks: false,
      // The stats object is used in methods below
      alwaysStat: true,
      // Watching on Windows seems to lock dirs with subdirs, preventing them
      // from being renamed/moved/deleted.
      usePolling: (process.platform === 'win32'),
      // Filter out artifacts from editors with atomic writes
      atomic: true,
      // Poll newly created files to detect when the write is finished
      awaitWriteFinish: {
        pollInterval: 200,
        stabilityThreshold: 1000
      },
      // With node 0.10 on linux, only polling is available
      interval: 1000,
      binaryInterval: 2000
    })

    return new Promise((resolve) => {
      for (let eventType of ['add', 'addDir', 'change', 'unlink', 'unlinkDir']) {
        this.watcher.on(eventType, (path?: string, stats?: fs.Stats) => {
          log.chokidar.debug({path}, eventType)
          log.chokidar.trace({stats})
          const newEvent = chokidarEvent.build(eventType, path, stats)
          this.buffer.push(newEvent)
          this.events.emit('buffering-start')
        })
      }

      // To detect which files&folders have been removed since the last run of
      // cozy-desktop, we keep all the paths seen by chokidar during its
      // initial scan in @paths to compare them with pouchdb database.
      this.initialScan = {ids: [], resolve}

      this.watcher
        .on('ready', () => this.buffer.switchMode('timeout'))
        .on('error', (err) => {
          if (err.message === 'watch ENOSPC') {
            log.error('Sorry, the kernel is out of inotify watches! ' +
              'See doc/usage/inotify.md for how to solve this issue.')
          } else {
            log.error({err})
          }
        })

      log.info(`Now watching ${this.syncPath}`)
    })
  }

  // TODO: Start checksuming as soon as an add/change event is buffered
  // TODO: Put flushed event batches in a queue
  async onFlush (events: ChokidarEvent[]) {
    log.debug(`Flushed ${events.length} events`)

    this.events.emit('buffering-end')
    this.ensureDirSync()
    this.events.emit('local-start')

    events = events.filter((e) => e.path !== '') // @TODO handle root dir events

    const initialScan = this.initialScan
    if (initialScan != null) {
      const ids = initialScan.ids
      events.filter((e) => e.type.startsWith('add'))
            .forEach((e) => ids.push(metadata.id(e.path)))

      await this.prependOfflineUnlinkEvents(events, initialScan)

      log.debug({initialEvents: events})
    }

    log.trace('Prepare events...')
    const preparedEvents : LocalEvent[] = await this.prepareEvents(events)
    log.trace('Done with events preparation.')

    const changes : LocalChange[] = analysis(preparedEvents, this.pendingChanges)

    // TODO: Don't even acquire lock changes list is empty
    // FIXME: Shouldn't we acquire the lock before preparing the events?
    const release = await this.pouch.lock(this)
    let target = -1
    try {
      await this.sendToPrep(changes)
      target = (await this.pouch.db.changes({limit: 1, descending: true})).last_seq
    } finally {
      this.events.emit('sync-target', target)
      release()
      this.events.emit('local-end')
    }
    if (initialScan != null) {
      initialScan.resolve()
      this.initialScan = null
    }
  }

  async prependOfflineUnlinkEvents (events: ChokidarEvent[], initialScan: InitialScan) {
    // Try to detect removed files & folders
    const docs = await this.pouch.byRecursivePathAsync('')
    const inInitialScan = (doc) =>
      initialScan.ids.indexOf(metadata.id(doc.path)) !== -1
    for (const doc of docs) {
      if (inInitialScan(doc) || doc.trashed) continue

      const event = (doc.docType === 'file')
        ? {type: 'unlink', path: doc.path, old: doc}
        : {type: 'unlinkDir', path: doc.path, old: doc}

      log.chokidar.debug({path: doc.path}, event.type)
      events.unshift(event)
    }
  }

  async prepareEvents (events: ChokidarEvent[]) : Promise<LocalEvent[]> {
    const oldMetadata = async (e: ChokidarEvent): Promise<?Metadata> => {
      if (e.old) return e.old
      if (e.type === 'unlink' || e.type === 'unlinkDir') {
        try {
          return await this.pouch.db.get(metadata.id(e.path))
        } catch (err) {
          if (err.status !== 404) log.error({path: e.path, err})
        }
      }
      return null
    }

    // @PERFOPTIM ?
    //   - db.allDocs(keys: events.pick(path))
    //   - process.exec('md5sum ' + paths.join(' '))

    return Promise.map(events, async (e: ChokidarEvent): Promise<?LocalEvent> => {
      const abspath = path.join(this.syncPath, e.path)

      const e2: Object = {
        ...e,
        old: await oldMetadata(e)
      }

      if (e.type === 'add' || e.type === 'change') {
        try {
          e2.md5sum = await this.checksum(e.path)
        } catch (err) {
          // FIXME: err.code === EISDIR => keep the event? (e.g. rm foo && mkdir foo)
          if (err.code.match(/ENOENT/)) {
            log.debug({path: e.path, ino: e.stats.ino}, 'File does not exist anymore')
            e2.wip = true
          } else {
            log.error({path: e.path, err}, 'Could not compute checksum')
            return null
          }
        }
      }

      if (e.type === 'addDir') {
        if (!await fs.exists(abspath)) {
          log.debug({path: e.path}, 'Dir does not exist anymore')
          e2.wip = true
          return null
        }
      }

      return e2
    }, {concurrency: 50})
    .filter((e: ?LocalEvent) => e != null)
  }

  // @TODO inline this.onXXX in this function
  // @TODO rename LocalChange types to prep.xxxxxx
  async sendToPrep (changes: LocalChange[]) {
    const errors: Error[] = []
    for (let c of changes) {
      try {
        switch (c.type) {
          // TODO: Inline old LocalWatcher methods
          case 'DirDeletion':
            await this.onUnlinkDir(c.path)
            break
          case 'FileDeletion':
            await this.onUnlinkFile(c.path)
            break
          case 'DirAddition':
            await this.onAddDir(c.path, c.stats)
            break
          case 'FileUpdate':
            await this.onChange(c.path, c.stats, c.md5sum)
            break
          case 'FileAddition':
            await this.onAddFile(c.path, c.stats, c.md5sum)
            break
          case 'FileMove':
            if (c.needRefetch) {
              c.old = await this.pouch.db.get(metadata.id(c.old.path))
              c.old.childMove = false
            }
            await this.onMoveFile(c.path, c.stats, c.md5sum, c.old)
            break
          case 'DirMove':
            await this.onMoveFolder(c.path, c.stats, c.old)
            break
          default:
            throw new Error('wrong changes')
        }
      } catch (err) {
        log.error({path: c.path, err})
        errors.push(err)
      }
    }

    if (errors.length > 0) {
      throw new Error(`Could not apply all changes to Prep:\n- ${errors.map(e => e.stack).join('\n- ')}`)
    }
  }

  stop (force?: bool) {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    clearInterval(this.ensureDirInterval)
    this.buffer.switchMode('idle')
    if (force) return Promise.resolve()
    // Give some time for awaitWriteFinish events to be fired
    return new Promise((resolve) => {
      setTimeout(resolve, 3000)
    })
  }

  // Show watched paths
  debug () {
    if (this.watcher) {
      log.info('This is the list of the paths watched by chokidar:')
      const object = this.watcher.getWatched()
      for (let dir in object) {
        var file
        const files = object[dir]
        if (dir === '..') {
          for (file of Array.from(files)) {
            log.info(`- ${dir}/${file}`)
          }
        } else {
          if (dir !== '.') { log.info(`- ${dir}`) }
          for (file of Array.from(files)) {
            log.info(`  * ${file}`)
          }
        }
      }
      log.info('--------------------------------------------------')
    } else {
      log.warn('The file system is not currrently watched')
    }
  }

  /* Helpers */
  async checksum (filePath: string): Promise<string> {
    const absPath = path.join(this.syncPath, filePath)
    return this.checksumer.push(absPath)
  }

  /* Changes */

  // New file detected
  onAddFile (filePath: string, stats: fs.Stats, md5sum: string) {
    const logError = (err) => log.error({err, path: filePath})
    const doc = metadata.buildFile(filePath, stats, md5sum)
    log.info({path: filePath}, 'file added')
    return this.prep.addFileAsync(SIDE, doc).catch(logError)
  }

  async onMoveFile (filePath: string, stats: fs.Stats, md5sum: string, old: Metadata) {
    const logError = (err) => log.error({err, path: filePath})
    const doc = metadata.buildFile(filePath, stats, md5sum)
    log.info({path: filePath}, `was moved from ${old.path}`)
    return this.prep.moveFileAsync(SIDE, doc, old).catch(logError)
  }

  onMoveFolder (folderPath: string, stats: fs.Stats, old: Metadata) {
    const logError = (err) => log.error({err, path: folderPath})
    const doc = metadata.buildDir(folderPath, stats)
    log.info({path: folderPath}, `was moved from ${old.path}`)
    return this.prep.moveFolderAsync(SIDE, doc, old).catch(logError)
  }

  // New directory detected
  onAddDir (folderPath: string, stats: fs.Stats) {
    const doc = metadata.buildDir(folderPath, stats)
    log.info({path: folderPath}, 'folder added')
    return this.prep.putFolderAsync(SIDE, doc).catch(err => log.error({err, path: folderPath}))
  }

  // File deletion detected
  //
  // It can be a file moved out. So, we wait a bit to see if a file with the
  // same checksum is added and, if not, we declare this file as deleted.
  onUnlinkFile (filePath: string) {
    log.info({path: filePath}, 'File deleted')
    return this.prep.trashFileAsync(SIDE, {path: filePath}).catch(err => log.error({err, path: filePath}))
  }

  // Folder deletion detected
  //
  // We don't want to delete a folder before files inside it. So we wait a bit
  // after chokidar event to declare the folder as deleted.
  onUnlinkDir (folderPath: string) {
    log.info({path: folderPath}, 'Folder deleted')
    return this.prep.trashFolderAsync(SIDE, {path: folderPath}).catch(err => log.error({err, path: folderPath}))
  }

  // File update detected
  onChange (filePath: string, stats: fs.Stats, md5sum: string) {
    log.info({path: filePath}, 'File changed')
    const doc = metadata.buildFile(filePath, stats, md5sum)
    return this.prep.updateFileAsync(SIDE, doc)
  }
}

export default LocalWatcher
