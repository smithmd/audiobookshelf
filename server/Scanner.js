const fs = require('fs-extra')
const Path = require('path')
const Logger = require('./Logger')
const BookFinder = require('./BookFinder')
const Audiobook = require('./objects/Audiobook')
const audioFileScanner = require('./utils/audioFileScanner')
const { groupFilesIntoAudiobookPaths, getAudiobookFileData, scanRootDir } = require('./utils/scandir')
const { comparePaths, getIno } = require('./utils/index')
const { secondsToTimestamp } = require('./utils/fileUtils')
const { ScanResult, CoverDestination } = require('./utils/constants')

class Scanner {
  constructor(AUDIOBOOK_PATH, METADATA_PATH, db, emitter) {
    this.AudiobookPath = AUDIOBOOK_PATH
    this.MetadataPath = METADATA_PATH
    this.BookMetadataPath = Path.join(this.MetadataPath, 'books')

    this.db = db
    this.emitter = emitter

    this.cancelScan = false

    this.bookFinder = new BookFinder()
  }

  get audiobooks() {
    return this.db.audiobooks
  }

  getCoverDirectory(audiobook) {
    if (this.db.serverSettings.coverDestination === CoverDestination.AUDIOBOOK) {
      return {
        fullPath: audiobook.fullPath,
        relPath: Path.join('/local', audiobook.path)
      }
    } else {
      return {
        fullPath: Path.join(this.BookMetadataPath, audiobook.id),
        relPath: Path.join('/metadata', 'books', audiobook.id)
      }
    }
  }

  async setAudioFileInos(audiobookDataAudioFiles, audiobookAudioFiles) {
    for (let i = 0; i < audiobookDataAudioFiles.length; i++) {
      var abdFile = audiobookDataAudioFiles[i]
      var matchingFile = audiobookAudioFiles.find(af => comparePaths(af.path, abdFile.path))
      if (matchingFile) {
        if (!matchingFile.ino) {
          matchingFile.ino = await getIno(matchingFile.fullPath)
        }
        abdFile.ino = matchingFile.ino
      } else {
        abdFile.ino = await getIno(abdFile.fullPath)
        if (!abdFile.ino) {
          Logger.error('[Scanner] Invalid abdFile ino - ignoring abd audio file', abdFile.path)
        }
      }
    }
    return audiobookDataAudioFiles.filter(abdFile => !!abdFile.ino)
  }

  // Only updates audio files with matching paths
  syncAudiobookInodeValues(audiobook, { audioFiles, otherFiles }) {
    var filesUpdated = 0

    // Sync audio files & audio tracks with updated inodes
    audiobook._audioFiles.forEach((audioFile) => {
      var matchingAudioFile = audioFiles.find(af => af.ino !== audioFile.ino && af.path === audioFile.path)
      if (matchingAudioFile) {
        // Audio Track should always have the same ino as the equivalent audio file (not all audio files have a track)
        var audioTrack = audiobook.tracks.find(t => t.ino === audioFile.ino)
        if (audioTrack) {
          Logger.debug(`[Scanner] Found audio file & track with mismatched inode "${audioFile.filename}" - updating it`)
          audioTrack.ino = matchingAudioFile.ino
          filesUpdated++
        } else {
          Logger.debug(`[Scanner] Found audio file with mismatched inode "${audioFile.filename}" - updating it`)
        }

        audioFile.ino = matchingAudioFile.ino
        filesUpdated++
      }
    })

    // Sync other files with updated inodes
    audiobook._otherFiles.forEach((otherFile) => {
      var matchingOtherFile = otherFiles.find(of => of.ino !== otherFile.ino && of.path === otherFile.path)
      if (matchingOtherFile) {
        Logger.debug(`[Scanner] Found other file with mismatched inode "${otherFile.filename}" - updating it`)
        otherFile.ino = matchingOtherFile.ino
        filesUpdated++
      }
    })

    return filesUpdated
  }

  async scanAudiobookData(audiobookData, forceAudioFileScan = false) {
    var existingAudiobook = this.audiobooks.find(a => a.ino === audiobookData.ino)

    // inode value may change when using shared drives, update inode if matching path is found
    // Note: inode will not change on rename
    var hasUpdatedIno = false
    if (!existingAudiobook) {
      // check an audiobook exists with matching path, then update inodes
      existingAudiobook = this.audiobooks.find(a => a.path === audiobookData.path)
      if (existingAudiobook) {
        hasUpdatedIno = true
        var filesUpdated = this.syncAudiobookInodeValues(existingAudiobook, audiobookData)
        Logger.info(`[Scanner] Updating inode value for "${existingAudiobook.title}" - ${filesUpdated} files updated`)
      }
    }

    // Logger.debug(`[Scanner] Scanning "${audiobookData.title}" (${audiobookData.ino}) - ${!!existingAudiobook ? 'Exists' : 'New'}`)
    if (existingAudiobook) {

      // TEMP: Check if is older audiobook and needs force rescan
      if (!forceAudioFileScan && existingAudiobook.checkNeedsAudioFileRescan()) {
        Logger.info(`[Scanner] Re-Scanning all audio files for "${existingAudiobook.title}" (last scan <= 1.3.0)`)
        forceAudioFileScan = true
      }


      // REMOVE: No valid audio files
      // TODO: Label as incomplete, do not actually delete
      if (!audiobookData.audioFiles.length) {
        Logger.error(`[Scanner] "${existingAudiobook.title}" no valid audio files found - removing audiobook`)

        await this.db.removeEntity('audiobook', existingAudiobook.id)
        this.emitter('audiobook_removed', existingAudiobook.toJSONMinified())

        return ScanResult.REMOVED
      }

      // ino is now set for every file in scandir
      audiobookData.audioFiles = audiobookData.audioFiles.filter(af => af.ino)

      // Check for audio files that were removed
      var abdAudioFileInos = audiobookData.audioFiles.map(af => af.ino)
      var removedAudioFiles = existingAudiobook.audioFiles.filter(file => !abdAudioFileInos.includes(file.ino))
      if (removedAudioFiles.length) {
        Logger.info(`[Scanner] ${removedAudioFiles.length} audio files removed for audiobook "${existingAudiobook.title}"`)
        removedAudioFiles.forEach((af) => existingAudiobook.removeAudioFile(af))
      }

      // Check for mismatched audio tracks - tracks with no matching audio file
      var removedAudioTracks = existingAudiobook.tracks.filter(track => !abdAudioFileInos.includes(track.ino))
      if (removedAudioTracks.length) {
        Logger.info(`[Scanner] ${removedAudioTracks.length} tracks removed no matching audio file for audiobook "${existingAudiobook.title}"`)
        removedAudioTracks.forEach((at) => existingAudiobook.removeAudioTrack(at))
      }

      // Check for new audio files and sync existing audio files
      var newAudioFiles = []
      var hasUpdatedAudioFiles = false
      audiobookData.audioFiles.forEach((file) => {
        var existingAudioFile = existingAudiobook.getAudioFileByIno(file.ino)
        if (existingAudioFile) { // Audio file exists, sync paths
          if (existingAudiobook.syncAudioFile(existingAudioFile, file)) {
            hasUpdatedAudioFiles = true
          }
        } else {
          var audioFileWithMatchingPath = existingAudiobook.getAudioFileByPath(file.fullPath)
          if (audioFileWithMatchingPath) {
            Logger.warn(`[Scanner] Audio file with path already exists with different inode, New: "${file.filename}" (${file.ino}) | Existing: ${audioFileWithMatchingPath.filename} (${audioFileWithMatchingPath.ino})`)
          } else {
            newAudioFiles.push(file)
          }
        }
      })

      // Rescan audio file metadata
      if (forceAudioFileScan) {
        Logger.info(`[Scanner] Rescanning ${existingAudiobook.audioFiles.length} audio files for "${existingAudiobook.title}"`)
        var numAudioFilesUpdated = await audioFileScanner.rescanAudioFiles(existingAudiobook)
        if (numAudioFilesUpdated > 0) {
          Logger.info(`[Scanner] Rescan complete, ${numAudioFilesUpdated} audio files were updated for "${existingAudiobook.title}"`)
          hasUpdatedAudioFiles = true

          // Use embedded cover art if audiobook has no cover
          if (existingAudiobook.hasEmbeddedCoverArt && !existingAudiobook.cover) {
            var outputCoverDirs = this.getCoverDirectory(existingAudiobook)
            var relativeDir = await existingAudiobook.saveEmbeddedCoverArt(outputCoverDirs.fullPath, outputCoverDirs.relPath)
            if (relativeDir) {
              Logger.debug(`[Scanner] Saved embedded cover art "${relativeDir}"`)
            }
          }
        } else {
          Logger.info(`[Scanner] Rescan complete, audio files were up to date for "${existingAudiobook.title}"`)
        }
      }

      // Scan and add new audio files found and set tracks
      if (newAudioFiles.length) {
        Logger.info(`[Scanner] ${newAudioFiles.length} new audio files were found for audiobook "${existingAudiobook.title}"`)
        await audioFileScanner.scanAudioFiles(existingAudiobook, newAudioFiles)
      }

      // If after a scan no valid audio tracks remain
      // TODO: Label as incomplete, do not actually delete
      if (!existingAudiobook.tracks.length) {
        Logger.error(`[Scanner] "${existingAudiobook.title}" has no valid tracks after update - removing audiobook`)

        await this.db.removeEntity('audiobook', existingAudiobook.id)
        this.emitter('audiobook_removed', existingAudiobook.toJSONMinified())
        return ScanResult.REMOVED
      }

      var hasUpdates = hasUpdatedIno || removedAudioFiles.length || removedAudioTracks.length || newAudioFiles.length || hasUpdatedAudioFiles

      // Check that audio tracks are in sequential order with no gaps
      if (existingAudiobook.checkUpdateMissingParts()) {
        Logger.info(`[Scanner] "${existingAudiobook.title}" missing parts updated`)
        hasUpdates = true
      }

      // Sync other files (all files that are not audio files)
      var otherFilesUpdated = await existingAudiobook.syncOtherFiles(audiobookData.otherFiles, forceAudioFileScan)
      if (otherFilesUpdated) {
        hasUpdates = true
      }

      // Syncs path and fullPath
      if (existingAudiobook.syncPaths(audiobookData)) {
        hasUpdates = true
      }

      // If audiobook was missing before, it is now found
      if (existingAudiobook.isMissing) {
        existingAudiobook.isMissing = false
        hasUpdates = true
        Logger.info(`[Scanner] "${existingAudiobook.title}" was missing but now it is found`)
      }

      // Save changes and notify users
      if (hasUpdates) {
        existingAudiobook.setChapters()

        Logger.info(`[Scanner] "${existingAudiobook.title}" was updated - saving`)
        existingAudiobook.lastUpdate = Date.now()
        await this.db.updateAudiobook(existingAudiobook)
        this.emitter('audiobook_updated', existingAudiobook.toJSONMinified())

        return ScanResult.UPDATED
      }

      return ScanResult.UPTODATE
    }

    // NEW: Check new audiobook
    if (!audiobookData.audioFiles.length) {
      Logger.error('[Scanner] No valid audio tracks for Audiobook', audiobookData.path)
      return ScanResult.NOTHING
    }

    var audiobook = new Audiobook()
    audiobook.setData(audiobookData)
    await audioFileScanner.scanAudioFiles(audiobook, audiobookData.audioFiles)
    if (!audiobook.tracks.length) {
      Logger.warn('[Scanner] Invalid audiobook, no valid tracks', audiobook.title)
      return ScanResult.NOTHING
    }

    if (audiobook.hasDescriptionTextFile) {
      await audiobook.saveDescriptionFromTextFile()
    }

    if (audiobook.hasEmbeddedCoverArt) {
      var outputCoverDirs = this.getCoverDirectory(audiobook)
      var relativeDir = await audiobook.saveEmbeddedCoverArt(outputCoverDirs.fullPath, outputCoverDirs.relPath)
      if (relativeDir) {
        Logger.debug(`[Scanner] Saved embedded cover art "${relativeDir}"`)
      }
    }

    audiobook.setDetailsFromFileMetadata()
    audiobook.checkUpdateMissingParts()
    audiobook.setChapters()

    Logger.info(`[Scanner] Audiobook "${audiobook.title}" Scanned (${audiobook.sizePretty}) [${audiobook.durationPretty}]`)
    await this.db.insertAudiobook(audiobook)
    this.emitter('audiobook_added', audiobook.toJSONMinified())
    return ScanResult.ADDED
  }

  async scan(forceAudioFileScan = false) {
    // TODO: This temporary fix from pre-release should be removed soon, "checkUpdateInos"
    // TEMP - update ino for each audiobook
    if (this.audiobooks.length) {
      for (let i = 0; i < this.audiobooks.length; i++) {
        var ab = this.audiobooks[i]
        // Update ino if inos are not set
        var shouldUpdateIno = ab.hasMissingIno
        if (shouldUpdateIno) {
          Logger.debug(`Updating inos for ${ab.title}`)
          var hasUpdates = await ab.checkUpdateInos()
          if (hasUpdates) {
            await this.db.updateAudiobook(ab)
          }
        }
      }
    }

    const scanStart = Date.now()
    var audiobookDataFound = await scanRootDir(this.AudiobookPath, this.db.serverSettings)

    // Remove audiobooks with no inode
    audiobookDataFound = audiobookDataFound.filter(abd => abd.ino)

    if (this.cancelScan) {
      this.cancelScan = false
      return null
    }

    var scanResults = {
      removed: 0,
      updated: 0,
      added: 0,
      missing: 0
    }

    // Check for removed audiobooks
    for (let i = 0; i < this.audiobooks.length; i++) {
      var audiobook = this.audiobooks[i]
      var dataFound = audiobookDataFound.find(abd => abd.ino === audiobook.ino)
      if (!dataFound) {
        Logger.info(`[Scanner] Audiobook "${audiobook.title}" is missing`)
        audiobook.isMissing = true
        audiobook.lastUpdate = Date.now()
        scanResults.missing++
        await this.db.updateAudiobook(audiobook)
        this.emitter('audiobook_updated', audiobook.toJSONMinified())
      }
      if (this.cancelScan) {
        this.cancelScan = false
        return null
      }
    }

    // Check for new and updated audiobooks
    for (let i = 0; i < audiobookDataFound.length; i++) {
      var result = await this.scanAudiobookData(audiobookDataFound[i], forceAudioFileScan)
      if (result === ScanResult.ADDED) scanResults.added++
      if (result === ScanResult.REMOVED) scanResults.removed++
      if (result === ScanResult.UPDATED) scanResults.updated++

      var progress = Math.round(100 * (i + 1) / audiobookDataFound.length)
      this.emitter('scan_progress', {
        scanType: 'files',
        progress: {
          total: audiobookDataFound.length,
          done: i + 1,
          progress
        }
      })
      if (this.cancelScan) {
        this.cancelScan = false
        break
      }
    }
    const scanElapsed = Math.floor((Date.now() - scanStart) / 1000)
    Logger.info(`[Scanned] Finished | ${scanResults.added} added | ${scanResults.updated} updated | ${scanResults.removed} removed | ${scanResults.missing} missing | elapsed: ${secondsToTimestamp(scanElapsed)}`)
    return scanResults
  }

  async scanAudiobookById(audiobookId) {
    const audiobook = this.db.audiobooks.find(ab => ab.id === audiobookId)
    if (!audiobook) {
      Logger.error(`[Scanner] Scan audiobook by id not found ${audiobookId}`)
      return ScanResult.NOTHING
    }
    Logger.info(`[Scanner] Scanning Audiobook "${audiobook.title}"`)
    return this.scanAudiobook(audiobook.fullPath, true)
  }

  async scanAudiobook(audiobookPath, forceAudioFileScan = false) {
    Logger.debug('[Scanner] scanAudiobook', audiobookPath)
    var audiobookData = await getAudiobookFileData(this.AudiobookPath, audiobookPath, this.db.serverSettings)
    if (!audiobookData) {
      return ScanResult.NOTHING
    }
    audiobookData.ino = await getIno(audiobookData.fullPath)
    return this.scanAudiobookData(audiobookData, forceAudioFileScan)
  }

  // Files were modified in this directory, check it out
  async checkDir(dir) {
    var exists = await fs.pathExists(dir)
    if (!exists) {
      // Audiobook was deleted, TODO: Should confirm this better
      var audiobook = this.db.audiobooks.find(ab => ab.fullPath === dir)
      if (audiobook) {
        var audiobookJSON = audiobook.toJSONMinified()
        await this.db.removeEntity('audiobook', audiobook.id)
        this.emitter('audiobook_removed', audiobookJSON)
        return ScanResult.REMOVED
      }

      // Path inside audiobook was deleted, scan audiobook
      audiobook = this.db.audiobooks.find(ab => dir.startsWith(ab.fullPath))
      if (audiobook) {
        Logger.info(`[Scanner] Path inside audiobook "${audiobook.title}" was deleted: ${dir}`)
        return this.scanAudiobook(audiobook.fullPath)
      }

      Logger.warn('[Scanner] Path was deleted but no audiobook found', dir)
      return ScanResult.NOTHING
    }

    // Check if this is a subdirectory of an audiobook
    var audiobook = this.db.audiobooks.find((ab) => dir.startsWith(ab.fullPath))
    if (audiobook) {
      Logger.debug(`[Scanner] Check Dir audiobook "${audiobook.title}" found: ${dir}`)
      return this.scanAudiobook(audiobook.fullPath)
    }

    // Check if an audiobook is a subdirectory of this dir
    audiobook = this.db.audiobooks.find(ab => ab.fullPath.startsWith(dir))
    if (audiobook) {
      Logger.warn(`[Scanner] Files were added/updated in a root directory of an existing audiobook, ignore files: ${dir}`)
      return ScanResult.NOTHING
    }

    // Must be a new audiobook
    Logger.debug(`[Scanner] Check Dir must be a new audiobook: ${dir}`)
    return this.scanAudiobook(dir)
  }

  // Array of files that may have been renamed, removed or added
  async filesChanged(filepaths) {
    if (!filepaths.length) return ScanResult.NOTHING
    var relfilepaths = filepaths.map(path => path.replace(this.AudiobookPath, ''))
    var fileGroupings = groupFilesIntoAudiobookPaths(relfilepaths, true)

    var results = []
    for (const dir in fileGroupings) {
      Logger.debug(`[Scanner] Check dir ${dir}`)
      var fullPath = Path.join(this.AudiobookPath, dir)
      var result = await this.checkDir(fullPath)
      Logger.debug(`[Scanner] Check dir result ${result}`)
      results.push(result)
    }
    return results
  }

  async scanCovers() {
    var audiobooksNeedingCover = this.audiobooks.filter(ab => !ab.cover && ab.author)
    var found = 0
    var notFound = 0
    for (let i = 0; i < audiobooksNeedingCover.length; i++) {
      var audiobook = audiobooksNeedingCover[i]
      var options = {
        titleDistance: 2,
        authorDistance: 2
      }
      var results = await this.bookFinder.findCovers('openlibrary', audiobook.title, audiobook.author, options)
      if (results.length) {
        Logger.debug(`[Scanner] Found best cover for "${audiobook.title}"`)
        audiobook.book.cover = results[0]
        await this.db.updateAudiobook(audiobook)
        found++
        this.emitter('audiobook_updated', audiobook.toJSONMinified())
      } else {
        notFound++
      }

      var progress = Math.round(100 * (i + 1) / audiobooksNeedingCover.length)
      this.emitter('scan_progress', {
        scanType: 'covers',
        progress: {
          total: audiobooksNeedingCover.length,
          done: i + 1,
          progress
        }
      })

      if (this.cancelScan) {
        this.cancelScan = false
        break
      }
    }
    return {
      found,
      notFound
    }
  }

  async saveMetadata(audiobookId) {
    if (audiobookId) {
      var audiobook = this.db.audiobooks.find(ab => ab.id === audiobookId)
      if (!audiobook) {
        return {
          error: 'Audiobook not found'
        }
      }
      var savedPath = await audiobook.writeNfoFile()
      return {
        audiobookId,
        audiobookTitle: audiobook.title,
        savedPath
      }
    } else {
      var response = {
        success: 0,
        failed: 0
      }
      for (let i = 0; i < this.db.audiobooks.length; i++) {
        var audiobook = this.db.audiobooks[i]
        var savedPath = await audiobook.writeNfoFile()
        if (savedPath) {
          Logger.info(`[Scanner] Saved metadata nfo ${savedPath}`)
          response.success++
        } else {
          response.failed++
        }
      }
      return response
    }
  }

  async find(req, res) {
    var method = req.params.method
    var query = req.query

    var result = null

    if (method === 'isbn') {
      result = await this.bookFinder.findByISBN(query)
    } else if (method === 'search') {
      result = await this.bookFinder.search(query.provider, query.title, query.author || null)
    }

    res.json(result)
  }

  async findCovers(req, res) {
    var query = req.query
    var options = {
      fallbackTitleOnly: !!query.fallbackTitleOnly
    }
    var result = await this.bookFinder.findCovers(query.provider, query.title, query.author || null, options)
    res.json(result)
  }
}
module.exports = Scanner