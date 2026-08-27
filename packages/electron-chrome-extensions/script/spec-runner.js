#!/usr/bin/env node

const childProcess = require('child_process')
const fs = require('fs')
const { createRequire } = require('module')
const path = require('path')
const unknownFlags = []

require('colors')
const pass = '✓'.green
const fail = '✗'.red

const args = require('minimist')(process.argv, {
  string: ['target'],
  unknown: (arg) => unknownFlags.push(arg),
})

const unknownArgs = []
for (const flag of unknownFlags) {
  unknownArgs.push(flag)
  const onlyFlag = flag.replace(/^-+/, '')
  if (args[onlyFlag]) {
    unknownArgs.push(args[onlyFlag])
  }
}

async function main() {
  await runElectronTests()
}

async function runElectronTests() {
  const errors = []

  const testResultsDir = process.env.ELECTRON_TEST_RESULTS_DIR

  try {
    console.info('\nRunning:')
    if (testResultsDir) {
      process.env.MOCHA_FILE = path.join(testResultsDir, `test-results.xml`)
    }
    await runMainProcessElectronTests()
  } catch (err) {
    errors.push([err])
  }

  if (errors.length !== 0) {
    for (const err of errors) {
      console.error('\n\nRunner Failed:', err[0])
      console.error(err[1])
    }
    console.log(`${fail} Electron test runners have failed`)
    process.exit(1)
  }
}

async function runMainProcessElectronTests() {
  let exe = require('electron')
  const runnerArgs = ['spec', ...unknownArgs.slice(2)]
  const cleanupPreloadResolution = prepareLocalPreloadResolution()

  // Fix issue in CI
  // "The SUID sandbox helper binary was found, but is not configured correctly."
  if (process.platform === 'linux') {
    runnerArgs.push('--no-sandbox')
  }

  let status
  let signal
  try {
    ;({ status, signal } = childProcess.spawnSync(exe, runnerArgs, {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: 'inherit',
    }))
  } finally {
    cleanupPreloadResolution()
  }
  if (status !== 0) {
    if (status) {
      const textStatus =
        process.platform === 'win32' ? `0x${status.toString(16)}` : status.toString()
      console.log(`${fail} Electron tests failed with code ${textStatus}.`)
    } else {
      console.log(`${fail} Electron tests failed with kill signal ${signal}.`)
    }
    process.exit(1)
  }
  console.log(`${pass} Electron main process tests passed.`)
}

/**
 * The monorepo's shell dependency provides an older unscoped
 * electron-chrome-extensions package at the repository root. The package
 * under test resolves its preload by package name, so give this runner a
 * temporary local self-reference and prove that it resolves to this checkout.
 */
function prepareLocalPreloadResolution() {
  const packageDir = path.resolve(__dirname, '..')
  const nodeModulesDir = path.join(packageDir, 'node_modules')
  const localPackageLink = path.join(nodeModulesDir, 'electron-chrome-extensions')
  const expectedPreload = path.join(packageDir, 'dist', 'chrome-extension-api.preload.js')

  if (fs.existsSync(localPackageLink)) {
    throw new Error(`Refusing to replace existing test package path: ${localPackageLink}`)
  }

  fs.mkdirSync(nodeModulesDir, { recursive: true })
  fs.symlinkSync(packageDir, localPackageLink, 'junction')

  try {
    const resolveFromPackage = createRequire(path.join(packageDir, 'dist', 'cjs', 'index.js'))
    const resolvedPreload = resolveFromPackage.resolve('electron-chrome-extensions/preload')
    if (fs.realpathSync(resolvedPreload) !== fs.realpathSync(expectedPreload)) {
      throw new Error(
        `Local preload resolution failed: expected ${expectedPreload}, received ${resolvedPreload}`,
      )
    }

    console.info(`[spec] using checkout preload: ${resolvedPreload}`)
  } catch (error) {
    fs.unlinkSync(localPackageLink)
    throw error
  }

  return () => fs.unlinkSync(localPackageLink)
}

main().catch((error) => {
  console.error('An error occurred inside the spec runner:', error)
  process.exit(1)
})
