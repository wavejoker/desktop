import * as ChildProcess from 'child_process'
import * as Path from 'path'
import * as Fs from 'fs-extra'
import * as Os from 'os'

/**
 * Handle Squirrel.Windows app lifecycle events.
 *
 * Returns a promise which will resolve when the work is done.
 */
export function handleSquirrelEvent(eventName: string): Promise<void> | null {
  switch (eventName) {
    case '--squirrel-install':
      return createShortcut()

    case '--squirrel-updated':
      return handleUpdated()

    case '--squirrel-uninstall':
      return handleUninstall()

    case '--squirrel-obsolete':
      return Promise.resolve()
  }

  return null
}

async function handleUpdated(): Promise<void> {
  await updateShortcut()

  const binPath = await writeCLITrampoline()
  const paths = await getPathSegments()
  if (paths.indexOf(binPath) < 0) {
    await setPathSegments([ ...paths, binPath ])
  }
}

/**
 * Get the path for the `bin` directory which exists in our `AppData` but
 * outside path which includes the installed app version.
 */
function getBinPath(): string {
  const appFolder = Path.resolve(process.execPath, '..')
  const rootAppDir = Path.resolve(appFolder, '..')
  return Path.join(rootAppDir, 'bin')
}

/**
 * Here's the problem: our app's path contains its version number. So each time
 * we update, the path to our app changes. So it's Real Hard to add our path
 * directly to `Path`. We'd have to detect and remove stale entries, etc.
 *
 * So instead, we write a trampoline out to a fixed path, still inside our
 * `AppData` directory but outside the version-specific path. That trampoline
 * just launches the current version's CLI tool. Then, whenever we update, we
 * rewrite the trampoline to point to the new, version-specific path. Bingo
 * bango Bob's your uncle.
 */
async function writeCLITrampoline(): Promise<string> {
  const binPath = getBinPath()
  const appFolder = Path.resolve(process.execPath, '..')
  const versionedPath = Path.relative(binPath, Path.join(appFolder, 'resources', 'app', 'static', 'github.bat'))
  const trampline = `@echo off\n"%~dp0\\${versionedPath}" %*`
  const trampolinePath = Path.join(binPath, 'github.bat')
  return new Promise<string>((resolve, reject) => {
    Fs.ensureDir(binPath, err => {
      if (err) {
        reject(err)
        return
      }

      Fs.writeFile(trampolinePath, trampline, err => {
        if (err) {
          reject(err)
        } else {
          resolve(binPath)
        }
      })
    })
  })
}

/** Spawn the Squirrel.Windows `Update.exe` with a command. */
async function spawnSquirrelUpdate(command: string): Promise<void> {
  const appFolder = Path.resolve(process.execPath, '..')
  const rootAppDir = Path.resolve(appFolder, '..')
  const updateDotExe = Path.resolve(Path.join(rootAppDir, 'Update.exe'))
  const exeName = Path.basename(process.execPath)

  await spawn(updateDotExe, [ command, exeName ])
}

function createShortcut(): Promise<void> {
  return spawnSquirrelUpdate('--createShortcut')
}

async function handleUninstall(): Promise<void> {
  await removeShortcut()

  const paths = await getPathSegments()
  const binPath = getBinPath()
  const pathsWithoutBinPath = paths.filter(p => p !== binPath)
  return setPathSegments(pathsWithoutBinPath)
}

function removeShortcut(): Promise<void> {
  return spawnSquirrelUpdate('--removeShortcut')
}

function updateShortcut(): Promise<void> {
  const homeDirectory = Os.homedir()
  if (homeDirectory) {
    const desktopShortcutPath = Path.join(homeDirectory, 'Desktop', 'GitHub Desktop.lnk')
    return new Promise<void>((resolve, reject) => {
      Fs.exists(desktopShortcutPath, exists => {
        if (exists) {
          createShortcut()
            .then(resolve)
            .catch(reject)
        } else {
          resolve()
        }
      })
    })
  } else {
    return createShortcut()
  }
}

/** Get the path segments in the user's `Path`. */
async function getPathSegments(): Promise<ReadonlyArray<string>> {
  let powershellPath: string
  const systemRoot = process.env['SystemRoot']
  if (systemRoot) {
    const system32Path = Path.join(process.env.SystemRoot, 'System32')
    powershellPath = Path.join(system32Path, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  } else {
    powershellPath = 'powershell.exe'
  }

  const args = [
    '-noprofile',
    '-ExecutionPolicy',
    'RemoteSigned',
    '-command',
    // Set encoding and execute the command, capture the output, and return it
    // via .NET's console in order to have consistent UTF-8 encoding.
    // See http://stackoverflow.com/questions/22349139/utf-8-output-from-powershell
    // to address https://github.com/atom/atom/issues/5063
    `
      [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
      $output=[environment]::GetEnvironmentVariable('Path', 'User')
      [Console]::WriteLine($output)
    `,
  ]

  const stdout = await spawn(powershellPath, args)
  const pathOutput = stdout.replace(/^\s+|\s+$/g, '')
  return pathOutput
    .split(/;+/)
    .filter(segment => segment.length)
}

/** Set the user's `Path`. */
async function setPathSegments(paths: ReadonlyArray<string>): Promise<void> {
  let setxPath: string
  const systemRoot = process.env['SystemRoot']
  if (systemRoot) {
    const system32Path = Path.join(systemRoot, 'System32')
    setxPath = Path.join(system32Path, 'setx.exe')
  } else {
    setxPath = 'setx.exe'
  }

  await spawn(setxPath, [ 'Path', paths.join(';') ])
}

/** Spawn a command with arguments and capture its output. */
function spawn(command: string, args: ReadonlyArray<string>): Promise<string> {
  try {
    const child = ChildProcess.spawn(command, args as string[])
    return new Promise<string>((resolve, reject) => {
      let stdout = ''
      child.stdout.on('data', data => {
        stdout += data
      })

      child.on('close', code => {
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(`Command failed: ${stdout}`))
        }
      })

      child.on('error', (err: Error) => {
        reject(err)
      })

      // This is necessary if using Powershell 2 on Windows 7 to get the events
      // to raise.
      // See http://stackoverflow.com/questions/9155289/calling-powershell-from-nodejs
      child.stdin.end()
    })
  } catch (error) {
    return Promise.reject(error)
  }
}
