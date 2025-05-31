import execa from 'execa'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { bin_name } from '../..'
import { BASH_PATH, ENGINE_DIR, MELON_TMP_DIR } from '../../constants'
import { log } from '../../log'
import { configDispatch, run } from '../../utils'
import { commandExistsSync } from '../../utils/command-exists'
import { downloadFileToLocation } from '../../utils/download'
import { ensureDirectory, windowsPathToUnix } from '../../utils/fs'
import { configureGitRepo, init } from '../init'
import { config } from '../..'
import {
  addAddonsToMozBuild,
  downloadAddon,
  generateAddonMozBuild,
  getAddons,
  initializeAddon,
  resolveAddonDownloadUrl,
  unpackAddon,
} from './addon'
import {
  configPath,
  getFFVersionOrCandidate,
  shouldUseCandidate,
} from '../../utils'
import fs from 'fs-extra'

export function shouldSetupFirefoxSource() {
  return !(
    existsSync(ENGINE_DIR) &&
    existsSync(resolve(ENGINE_DIR, 'toolkit', 'moz.build'))
  )
}

export async function setupFirefoxSource(version: string, isCandidate = false) {
  const firefoxSourceTar = await downloadFirefoxSource(version, isCandidate)

  await unpackFirefoxSource(firefoxSourceTar)

  if (!process.env.CI_SKIP_INIT) {
    log.info('Init firefox')
    await init(ENGINE_DIR)
  }
}

async function unpackFirefoxSource(name: string): Promise<void> {
  log.info(`Unpacking Firefox...`)

  ensureDirectory(ENGINE_DIR)
  let tarExec = 'tar'

  // On MacOS, we need to use gnu tar, otherwise tar doesn't behave how we
  // would expect it to behave, so this section is responsible for handling
  // that
  //
  // If BSD tar adds --transform support in the future, we can use that
  // instead
  if (process.platform == 'darwin') {
    // GNU Tar doesn't come preinstalled on any MacOS machines, so we need to
    // check for it and ask for the user to install it if necessary
    if (!commandExistsSync('gtar')) {
      throw new Error(
        `GNU Tar is required to extract Firefox's source on MacOS. Please install it using the command |brew install gnu-tar| or |sudo port install gnutar| and try again`
      )
    }

    tarExec = 'gtar'
  }

  log.info(`Unpacking ${resolve(MELON_TMP_DIR, name)} to ${ENGINE_DIR}`)
  if (process.platform === 'win32') {
    log.info('Unpacking Firefox source on Windows (7z)')
    await execa('7z', [
      'x',
      resolve(MELON_TMP_DIR, name),
      '-o' + resolve(MELON_TMP_DIR, name.replace('.tar.xz', '.tar')),
    ])
    log.info('Unpacking Firefox source again without the .xz extension')
    await execa('7z', [
      'x',
      resolve(MELON_TMP_DIR, name.replace('.tar.xz', '.tar')),
      '-o' + MELON_TMP_DIR,
    ])
    const archiveDir = resolve(
      MELON_TMP_DIR,
      'firefox-' + getFFVersionOrCandidate()
    )
    if (existsSync(ENGINE_DIR)) {
      // remove the existing engine directory
      fs.removeSync(ENGINE_DIR)
    }
    log.info('Moving Firefox source to engine directory')
    fs.moveSync(archiveDir, ENGINE_DIR)
    return
  }

  await execa(
    tarExec,
    [
      '--strip-components=1',
      '-xf',
      resolve(MELON_TMP_DIR, name),
      '-C',
      ENGINE_DIR,
    ].filter(Boolean) as string[],
    {
      shell: BASH_PATH,
    }
  )
  log.info(`Unpacked Firefox source to ${ENGINE_DIR}`)
}

async function downloadFirefoxSource(version: string, isCandidate = false) {
  let base = `https://archive.mozilla.org/pub/firefox/releases/${version}/source/`
  if (isCandidate) {
    console.log('Using candidate build')
    base = `https://archive.mozilla.org/pub/firefox/candidates/${version}-candidates/build1/source/`
  }
  const filename = `firefox-${version}.source.tar.xz`

  const url = base + filename

  const fsParent = MELON_TMP_DIR
  const fsSaveLocation = resolve(fsParent, filename)

  log.info(`Locating Firefox release ${version}...`)

  await ensureDirectory(dirname(fsSaveLocation))

  if (existsSync(fsSaveLocation)) {
    log.info('Using cached download')
    return filename
  }

  // Do not re-download if there is already an existing workspace present
  if (existsSync(ENGINE_DIR))
    log.error(
      `Workspace already exists.\nRemove that workspace and run |${bin_name} download ${version}| again.`
    )

  log.info(`Downloading Firefox release ${version}...`)

  await downloadFileToLocation(url, resolve(MELON_TMP_DIR, filename))
  return filename
}

export async function downloadWithGit(
  tag: string,
  {
    force = false,
    fullHistory = false,
  }: { force?: boolean; fullHistory?: boolean } = {}
) {
  if (force && existsSync(ENGINE_DIR)) {
    log.info('Removing existing workspace')
    await fsp.rm(ENGINE_DIR, { recursive: true })
  }

  // If the engine directory is empty, we should delete it.
  const engineIsEmpty = await readdir(ENGINE_DIR)
    .then((files) => files.length === 0)
    .catch(() => false)
  if (engineIsEmpty) {
    log.info("'engine/' is empty, removing it...")
    rmSync(ENGINE_DIR, { recursive: true })
  }

  // if it exists, fetch the latest changes
  if (existsSync(ENGINE_DIR)) {
    const wasShallow = await run('git', {
      args: ['rev-parse', '--is-shallow-repository'],
      cwd: ENGINE_DIR,
    })
      .then(({ output }) => output.join(''))
      .then((output) => output === 'true')

    log.info('running `git fetch`, this may take some time...')
    await run('git', {
      args: [
        'fetch',
        ...(fullHistory
          ? ['--unshallow']
          : ['--depth=1', 'origin', 'tag', tag]),
      ],
      cwd: ENGINE_DIR,
    })

    const headSha = await run('git', {
      args: ['rev-parse', 'HEAD'],
      cwd: ENGINE_DIR,
    }).then(({ output }) => output.join(''))
    const tagSha = await run('git', {
      args: ['rev-parse', tag],
      cwd: ENGINE_DIR,
    }).then(({ output }) => output.join(''))

    // if we're converting from a shallow clone to a non-shallow clone
    // then we also need to setup the repo so that the branch history
    // is correctly setup
    if (wasShallow || headSha !== tagSha) {
      await setupGitRepo(tag)
    } else {
      log.info(`Already at tag ${tag}`)
    }

    return
  }

  log.info(
    `Performing a ${
      fullHistory ? 'full depth' : 'shallow'
    } clone, this may take a while...`
  )
  await run('git', {
    args: [
      'clone',
      ...(fullHistory ? [] : ['--depth=1', `--branch=${tag}`]),
      'git@github.com:mozilla-firefox/firefox.git',
      ENGINE_DIR,
    ],
  })
  await setupGitRepo(tag)
}

async function setupGitRepo(tag: string) {
  const devBranch = `dev-${tag}`

  // general configuration
  log.info(`Configuring repo`)
  await configureGitRepo(ENGINE_DIR)

  // cleanup any existing code (probably overkill)
  log.info(`Cleaning up repo`)
  await run('git', {
    args: ['stash', '--include-untracked'],
    cwd: ENGINE_DIR,
  }).catch(() => null)
  await run('git', { args: ['clean', '-fd'], cwd: ENGINE_DIR }).catch(
    () => null
  )
  await run('git', {
    args: ['reset', '--hard', tag],
    cwd: ENGINE_DIR,
  })

  log.info(`Checking out tag ${tag} to branch ${devBranch}`)

  const currentBranch = await run('git', {
    args: ['branch', '--show-current'],
    cwd: ENGINE_DIR,
  }).then(({ output }) => output.join(''))
  if (currentBranch !== devBranch) {
    await run('git', {
      args: ['branch', '-D', devBranch],
      cwd: ENGINE_DIR,
    }).catch(() => null)

    await run('git', {
      args: ['switch', '-f', '-c', devBranch],
      cwd: ENGINE_DIR,
    })
  }
}

export async function downloadInternals({
  version,
  force,
  isCandidate = shouldUseCandidate(),
}: {
  version: string
  force?: boolean
  isCandidate?: boolean
}) {
  // Provide a legible error if there is no version specified
  if (!version) {
    log.error(
      'You have not specified a version of firefox in your config file. This is required to build a firefox fork.'
    )
    process.exit(1)
  }

  if (isCandidate) {
    version = config.version.candidate as string
  }

  if (force && existsSync(ENGINE_DIR)) {
    log.info('Removing existing workspace')
    rmSync(ENGINE_DIR, { recursive: true })
  }

  // If the engine directory is empty, we should delete it.
  const engineIsEmpty =
    existsSync(ENGINE_DIR) &&
    (await readdir(ENGINE_DIR).then((files) => files.length === 0))
  if (engineIsEmpty) {
    log.info("'engine/' is empty, it...")
    rmSync(ENGINE_DIR, { recursive: true })
  }

  if (!existsSync(ENGINE_DIR)) {
    await setupFirefoxSource(version, isCandidate)
  }

  for (const addon of getAddons()) {
    const downloadUrl = await resolveAddonDownloadUrl(addon)
    const downloadedXPI = await downloadAddon(downloadUrl, addon)

    await unpackAddon(downloadedXPI, addon)
    await generateAddonMozBuild(addon)
    await initializeAddon(addon)
  }

  await addAddonsToMozBuild(getAddons())

  if (!isCandidate) {
    config.version.version = version
  } else {
    config.version.candidate = version
  }
  writeFileSync(configPath, JSON.stringify(config, undefined, 2))
}
