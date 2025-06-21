import { config } from '..'
import { getCurrentBrandName } from '../commands/package'
import { getFFVersionOrCandidate } from '../utils'

const otherBuildModes = `# You can change to other build modes by running:
#   $ glider set buildMode [dev|debug|release]`

export const internalMozconfg = (
  brand: string,
  buildMode: 'dev' | 'debug' | 'release' | string
) => {
  let buildOptions = `# Unknown build mode ${buildMode}`

  // Get the specific build options for the current build mode
  switch (buildMode) {
    case 'dev': {
      buildOptions = `# Development build settings
${otherBuildModes}
ac_add_options --disable-debug`
      break
    }
    case 'debug': {
      buildOptions = `# Debug build settings
${otherBuildModes}
ac_add_options --enable-debug
ac_add_options --disable-optimize`
      break
    }

    case 'release': {
      buildOptions = `# Release build settings
ac_add_options --disable-debug
ac_add_options --enable-optimize
ac_add_options --enable-rust-simd`
      break
    }
  }

  return (
    `
# =====================
# Internal glider config
# =====================

${buildOptions}

# Custom branding
ac_add_options --with-branding=browser/branding/${brand}

# Config for updates
ac_add_options --enable-unverified-updates
ac_add_options --enable-update-channel=${brand}

export GLIDE_FIREFOX_VERSION=${getFFVersionOrCandidate()}
export MOZ_APPUPDATE_HOST=${
      config.updateHostname || 'localhost:7648 # This should not resolve'
    }
` +
    ((process as any).gliderPlatform === 'darwin'
      ? `

# MacOS specific settings
export MOZ_MACBUNDLE_NAME="${getCurrentBrandName()}.app"
  `
      : '')
  )
}
