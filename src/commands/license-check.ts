// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { SRC_DIR } from '../constants'
import { walkDirectory } from '../utils/fs'
import { Task, TaskList } from '../utils/task-list'

const ignoredFiles = new RegExp(
  '.*\\.(json|patch|md|jpeg|png|gif|webp|tiff|ico|woff2|DS_Store|gitignore)'
)
const licenseIgnore = new RegExp('(//|#) Ignore license in this file', 'g')
const fixableFiles = [
  { regex: new RegExp('.*\\.(m?)(j|t)s'), comment: '// ', commentClose: '\n' },
  {
    regex: new RegExp('.*(\\.inc)?\\.css'),
    commentOpen: '/*\n',
    comment: ' * ',
    commentClose: '\n */',
  },
  {
    regex: new RegExp('.*\\.(html|svg|xml)'),
    commentOpen: '<!--\n',
    comment: '   - ',
    commentClose: '\n   -->',
  },
  {
    regex: new RegExp('.*\\.py|moz\\.build|jar\\.mn|\\.toml'),
    commentOpen: '',
    comment: '# ',
    commentClose: '\n',
  },
]

export async function isValidLicense(path: string): Promise<boolean> {
  const file = await readFile(path, { encoding: 'utf8' })
  const contents = file.split('\n')

  // We need to grab the top 5 lines just in case there are newlines in the
  // comment blocks
  const lines = [
    contents[0],
    contents[1],
    contents[2],
    contents[3],
    contents[4],
  ].join('\n')
  const hasLicense =
    (lines.includes('the Mozilla Public') &&
      lines.includes('If a copy of the MPL was') &&
      lines.includes('http://mozilla.org/MPL/2.0/')) ||
    licenseIgnore.test(contents.join('\n'))

  return hasLicense
}

export function createTask(path: string, noFix: boolean): Task {
  return {
    skip: () => {
      if (ignoredFiles.test(path)) {
        return true
      }

      const relPath = path.replace(SRC_DIR, '')
      return (
        // compiled files
        relPath.startsWith('/glide/docs/dist') ||
        relPath.startsWith('/glide/bundled') ||
        relPath.startsWith('/glide/generated/') ||
        relPath.endsWith('bundled.compiled.d.ts') ||
        // Mozilla does not appear to put licenses in these files
        relPath.endsWith('chrome.manifest')
      )
    },
    name: path.replace(SRC_DIR, ''),
    task: async () => {
      const contents = await readFile(path, { encoding: 'utf8' })
      const contentsSplitNewline = contents.split('\n')
      const hasLicense = await isValidLicense(path)

      if (hasLicense) {
        return
      }

      const fixable = fixableFiles.find(({ regex }) => regex.test(path))

      if (!fixable || noFix) {
        throw new Error(
          `${path} does not have a license. Please add the source code header`
        )
      }

      const mplHeader = // eslint-disable-next-line unicorn/prefer-module
        await readFile(join(__dirname, 'license-check.txt'), {
          encoding: 'utf8',
        })
      const { comment, commentOpen, commentClose } = fixable
      let header = mplHeader
        .split('\n')
        .map((ln) => (comment || '') + ln)
        .join('\n')

      if (commentOpen) {
        header = commentOpen + header + commentClose
      }

      await writeFile(path, header + '\n\n' + contentsSplitNewline.join('\n'))
    },
  }
}

interface Options {
  fix: boolean
}

export const licenseCheck = async (options: Options): Promise<void> => {
  const files = await walkDirectory(SRC_DIR)

  await new TaskList(files.map((file) => createTask(file, !options.fix)))
    .onError('inline')
    .run()
}
