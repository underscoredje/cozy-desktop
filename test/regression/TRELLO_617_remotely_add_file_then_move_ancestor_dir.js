/* eslint-env mocha */
/* @flow */

// import { Client as CozyClient } from 'cozy-client-js'
// import EventEmitter from 'events'
import should from 'should'
import sinon from 'sinon'

// import Prep from '../../core/prep'
// import RemoteCozy from '../../core/remote/cozy'
import RemoteWatcher from '../../core/remote/watcher'

import configHelpers from '../helpers/config'
import * as cozyHelpers from '../helpers/cozy'
// import { IntegrationTestHelpers } from '../helpers/integration'
import pouchHelpers from '../helpers/pouch'

describe('TRELLO #484: Remotely add file then move ancestor dir (https://trello.com/c/TDNrUsgF)', () => {
  before(configHelpers.createConfig)
  before(configHelpers.registerClient)
  beforeEach(pouchHelpers.createDatabase)
  beforeEach(cozyHelpers.deleteAll)

  afterEach(pouchHelpers.cleanDatabase)
  after(configHelpers.cleanConfig)

  it('is fixed', async function () {
    // const prep = sinon.createStubInstance(Prep)
    // prep.config = this.config
    // const remoteCozy = new RemoteCozy(this.config)
    // remoteCozy.client = new CozyClient({
    //   cozyURL: this.config.cozyUrl,
    //   token: process.env.COZY_STACK_TOKEN
    // })
    // const events = new EventEmitter()
    // const watcher = new RemoteWatcher(this.pouch, prep, remoteCozy, events)

    // $FlowFixMe
    const watcher = new RemoteWatcher(this.pouch, {config: this.config}, null, {emit: () => {}})
    const applyAll = sinon.stub(watcher, 'applyAll')
    this.pouch.put({
      "path": "Administratif/Trainline",
      "docType": "folder",
      "updated_at": "2017-07-20T11:46:28.756527736Z",
      "remote": {
        "_id": "ff35786eacc8bb9c8b09b89f03e296da",
        "_rev": "2-8403e624f775ea736611e2fbbbf68f5e"
      },
      "tags": [],
      "sides": {
        "remote": 2,
        "local": 2
      },
      "ino": 281474976879705,
      "_id": "ADMINISTRATIF/TRAINLINE",
      // "_rev": "2-acd3fe7677854c6599fe6940bf3108ac"
    })

    await watcher.pullMany([
      {
        "_id": "81875c036d278706d8e590463e934529",
        "_rev": "2-5e6050be1f9bb5caff0753db61085afa",
        "class": "pdf",
        "created_at": "2018-01-24T16:38:20Z",
        "dir_id": "87a477775bfa3b753f66c3ed1cf25575",
        "executable": false,
        "md5sum": "ckasewHpjveEvD+cGwze1Q==",
        "mime": "application/pdf",
        "name": "2018_01_04_8b61_Trainline.pdf",
        "size": "52773",
        "tags": [],
        "trashed": false,
        "type": "file",
        "updated_at": "2018-01-24T16:38:20Z",
        "path": "/Administratif/Billets de train/sebastien_nicouleaud_net/2018_01_04_8b61_Trainline.pdf"
      },
      {
        "_id": "87a477775bfa3b753f66c3ed1cf25575",
        "_rev": "3-1a1dec6f448539a287a65b68e7e69056",
        "created_at": "2018-01-24T16:38:15.671787242Z",
        "dir_id": "ff35786eacc8bb9c8b09b89f03e296da",
        "name": "sebastien_nicouleaud_net",
        "path": "/Administratif/Billets de train/sebastien_nicouleaud_net",
        "referenced_by": [
          {
            "id": "io.cozy.konnectors%2Ftrainline",
            "type": "io.cozy.konnectors"
          }
        ],
        "tags": [],
        "type": "directory",
        "updated_at": "2018-01-24T16:38:15.671787242Z"
      },
      {
        "_id": "ff35786eacc8bb9c8b09b89f03e296da",
        "_rev": "3-c75c3b4b9a4134d409e0d783bf595946",
        "created_at": "2017-07-20T11:46:28.756527736Z",
        "dir_id": "ff35786eacc8bb9c8b09b89f03e0941c",
        "name": "Billets de train",
        "path": "/Administratif/Billets de train",
        "referenced_by": [
          {
            "id": "io.cozy.konnectors%2Ftrainline",
            "type": "io.cozy.konnectors"
          }
        ],
        "tags": [],
        "type": "directory",
        "updated_at": "2018-01-24T16:40:01.261Z"
      }
    ])

    should(applyAll.args[0][0].map(change => change.type))
      .deepEqual(['FolderMoved', 'FolderAdded', 'FileAdded'])
  })
})
