/* @flow */

import type { Scenario } from '..'

module.exports = ({
  init: [
    {ino: 1, path: 'src/'}
  ],
  actions: [
    {type: '>', path: 'src/file'},
    {type: 'wait', ms: 1500},
    {type: 'mv', src: 'src', dst: 'dst'}
  ],
  expected: {
    prepCalls: [
      {method: 'moveFolderAsync', src: 'src', dst: 'dst'},
      {method: 'addFileAsync', path: 'dst/file'}
    ],
    tree: [
      'dst/',
      'dst/file'
    ],
    remoteTrash: []
  }
}: Scenario)
