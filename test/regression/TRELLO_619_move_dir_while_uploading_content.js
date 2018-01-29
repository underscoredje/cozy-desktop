/* eslint-env mocha */
/* @flow */

import fs from 'fs-extra'
import _ from 'lodash'
import should from 'should'
import sinon from 'sinon'

import { runActions, init } from '../helpers/scenarios'
import configHelpers from '../helpers/config'
import * as cozyHelpers from '../helpers/cozy'
import { IntegrationTestHelpers } from '../helpers/integration'
import pouchHelpers from '../helpers/pouch'

let helpers

// Spies
// let prepCalls

describe('TRELLO #484: Local sort before squash (https://trello.com/c/RcRmqymw)', function () {
  before(configHelpers.createConfig)
  before(configHelpers.registerClient)
  beforeEach(pouchHelpers.createDatabase)
  beforeEach(cozyHelpers.deleteAll)
  beforeEach('set up synced dir', async function () {
    await fs.emptyDir(this.syncPath)
  })

  afterEach(pouchHelpers.cleanDatabase)
  after(configHelpers.cleanConfig)

  beforeEach(async function () {
    helpers = new IntegrationTestHelpers(this.config, this.pouch, cozyHelpers.cozy)
    // prepCalls = []
    //
    // for (let method of ['addFileAsync', 'putFolderAsync', 'updateFileAsync',
    //   'moveFileAsync', 'moveFolderAsync', 'deleteFolderAsync', 'trashFileAsync',
    //   'trashFolderAsync', 'restoreFileAsync', 'restoreFolderAsync']) {
    //   // $FlowFixMe
    //   const origMethod = helpers.prep[method]
    //   sinon.stub(helpers.prep, method).callsFake(async (...args) => {
    //     const call: Object = {method}
    //     if (method.startsWith('move') || method.startsWith('restore')) {
    //       call.dst = args[1].path
    //       call.src = args[2].path
    //     } else {
    //       call.path = args[1].path
    //     }
    //     prepCalls.push(call)
    //
    //     // Call the actual method so we can make assertions on metadata & FS
    //     return origMethod.apply(helpers.prep, args)
    //   })
    // }
  })

  it('is fixed', async function () {
    const {syncDir} = helpers.local
    const {remote} = helpers.remote
    const {addFileAsync} = remote
    const mtime = new Date('2017-10-09T08:40:52.521Z')
    const ctime = mtime

    // Simulate dir added with content
    await syncDir.ensureDir('src')
    await syncDir.writeFile('src/file1', '1')
    await syncDir.writeFile('src/file2', '22')
    await syncDir.writeFile('src/file3', '333')
    await helpers.local.simulateEvents([
      {type: 'addDir', path: 'src', stats: {ino: 4, mtime, ctime}},
      {type: 'add', path: 'src/file1', stats: {ino: 1, size: 1, mtime, ctime}},
      {type: 'add', path: 'src/file2', stats: {ino: 2, size: 2, mtime, ctime}},
      {type: 'add', path: 'src/file3', stats: {ino: 3, size: 3, mtime, ctime}}
    ])

    // Simulate dir moved while uploading
    const stub = sinon.stub(remote, 'addFileAsync')
    let p
    stub.onSecondCall().callsFake(async doc => {
      console.log('SIMULATE MOVE')
      await syncDir.move('src', 'dst')
      p = helpers.local.simulateEvents([
        {type: 'unlinkDir', path: 'src'},
        {type: 'addDir', path: 'dst', stats: {ino: 4, mtime, ctime}},
        {type: 'unlink', path: 'src/file1'},
        {type: 'unlink', path: 'src/file2'},
        {type: 'unlink', path: 'src/file3'},
        {type: 'add', path: 'dst/file1', stats: {ino: 1, size: 1, mtime, ctime}},
        {type: 'add', path: 'dst/file2', stats: {ino: 2, size: 2, mtime, ctime}},
        {type: 'add', path: 'dst/file3', stats: {ino: 3, size: 3, mtime, ctime}}
      ]).then(() => helpers.syncAll())
      return addFileAsync.call(remote, doc)
    })
    stub.callThrough()
    await helpers.syncAll()
    await p

    should(await helpers.remote.tree()).deepEqual([
      '.cozy_trash/',
      'dst/',
      'dst/file1',
      'dst/file2',
      'dst/file3'
    ])
  })
})
