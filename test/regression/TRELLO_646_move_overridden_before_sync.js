/* eslint-env mocha */
/* @flow */

import fs from 'fs-extra'
import _ from 'lodash'
import should from 'should'

import { runActions, init } from '../support/helpers/scenarios'
import configHelpers from '../support/helpers/config'
import * as cozyHelpers from '../support/helpers/cozy'
import { IntegrationTestHelpers } from '../support/helpers/integration'
import pouchHelpers from '../support/helpers/pouch'

describe('TRELLO #646: Déplacement écrasé avant synchro (malgré la synchro par lot, https://trello.com/c/Co05qttn)', () => {
  let helpers

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
    await helpers.local.setupTrash()
  })

  it('is broken', async function () {
    const pouchTree = async () => _.chain(
      await this.pouch.byRecursivePathAsync('')).map('_id').sort().value()

    // Initial state
    const ctime = new Date('2017-10-09T08:40:51.472Z')
    const mtime = ctime
    await helpers.remote.ignorePreviousChanges()
    await init({init: [{ino: 1, path: 'src/'}, {ino: 2, path: 'src/file'}]}, this.pouch, helpers.local.syncDir.abspath, _.identity)

    // Move (not detected yet)
    await runActions({actions: [{type: 'mv', src: 'src', dst: 'dst'}]}, helpers.local.syncDir.abspath, _.identity)

    // Detect and merge move
    // $FlowFixMe
    await helpers.local.simulateEvents([
      {type: 'unlinkDir', path: 'src'},
      {type: 'addDir', path: 'dst', stats: {ino: 1, size: 4096, mtime, ctime}},
      {type: 'unlink', path: 'src/file'},
      {type: 'add', path: 'dst/file', stats: {ino: 2, size: 0, mtime, ctime}}
    ])
    should(await helpers.local.tree()).deepEqual(['dst/', 'dst/file'])
    should(await helpers.remote.tree()).deepEqual(['.cozy_trash/', 'src/', 'src/file'])
    should(await pouchTree()).deepEqual(['DST', 'DST/FILE'])

    // Polling occurs before syncing move (recreates src metadata and breaks move)
    await helpers.remote.pullChanges()
    should(await helpers.local.tree()).deepEqual(['dst/', 'dst/file'])
    should(await helpers.remote.tree()).deepEqual(['.cozy_trash/', 'src/', 'src/file'])
    should(await pouchTree()).deepEqual(['DST', 'DST/FILE', 'SRC'])

    // Sync move
    await helpers.syncAll()
    should(await helpers.local.tree()).deepEqual(['dst/', 'dst/file', 'src/'])
    should(await helpers.remote.tree()).deepEqual(['.cozy_trash/', 'dst/', 'src/', 'src/file'])
    should(await pouchTree()).deepEqual(['DST', 'DST/FILE', 'SRC'])

    // Sync polling twice, just to be sure
    await helpers.syncAll()
    await helpers.remote.pullChanges()
    await helpers.syncAll()
    should(await helpers.local.tree()).deepEqual(['dst/', 'dst/file', 'src/'])
    should(await helpers.remote.tree()).deepEqual(['.cozy_trash/', 'dst/', 'src/', 'src/file'])
    should(await pouchTree()).deepEqual(['DST', 'DST/FILE', 'SRC'])
  })
})
