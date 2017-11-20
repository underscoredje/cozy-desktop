module.exports = {
  init: [
    {ino: 1, path: 'dir2/'},
    {ino: 2, path: 'dir2/empty-subdir/'},
    {ino: 3, path: 'dir2/subdir/'},
    {ino: 4, path: 'dir2/subdir/file'}
  ],
  actions: [
    {type: 'copy', src: 'dir2', dst: 'dir1'}
  ],
  expected: {
    prepCalls: [],
    tree: [
      'dir1/',
      'dir1/empty-subdir/',
      'dir1/subdir/',
      'dir1/subdir/file',
      'dir2/',
      'dir2/empty-subdir/',
      'dir2/subdir/',
      'dir2/subdir/file',
    ],
    remoteTrash: []
  }
}
