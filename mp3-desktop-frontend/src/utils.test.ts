// Path helpers. These are pure string operations, so they are exactly where a
// POSIX-only assumption hides — and on Windows a wrong `dirOf` silently strands
// the track table after a rename.
import { describe, expect, it } from 'vitest'
import { dirOf, joinPath } from './utils'

describe('dirOf', () => {
  it('returns the directory of a POSIX path', () => {
    expect(dirOf('/Users/me/Music/song.mp3')).toBe('/Users/me/Music')
  })

  it('returns the directory of a Windows path', () => {
    expect(dirOf('C:\\Users\\me\\Music\\song.mp3')).toBe('C:\\Users\\me\\Music')
  })

  it('handles a Windows path with forward slashes', () => {
    expect(dirOf('C:/Users/me/Music/song.mp3')).toBe('C:/Users/me/Music')
  })

  it('returns an empty string for a bare file name', () => {
    expect(dirOf('song.mp3')).toBe('')
  })

  it('keeps the root of a POSIX path', () => {
    // A file directly in "/" must not become a relative path after a rename.
    expect(dirOf('/song.mp3')).toBe('/')
    expect(joinPath(dirOf('/song.mp3'), 'other.mp3')).toBe('/other.mp3')
  })

  it('keeps the drive of a file at the root of a Windows drive', () => {
    expect(dirOf('C:\\song.mp3')).toBe('C:')
    expect(joinPath(dirOf('C:\\song.mp3'), 'other.mp3')).toBe('C:\\other.mp3')
  })
})

describe('joinPath', () => {
  it('joins with a forward slash on a POSIX path', () => {
    expect(joinPath('/Users/me/Music', 'new.mp3')).toBe('/Users/me/Music/new.mp3')
  })

  it('joins with a backslash on a Windows path', () => {
    expect(joinPath('C:\\Users\\me\\Music', 'new.mp3')).toBe('C:\\Users\\me\\Music\\new.mp3')
  })

  it('does not double a trailing separator', () => {
    expect(joinPath('/Users/me/Music/', 'new.mp3')).toBe('/Users/me/Music/new.mp3')
    expect(joinPath('C:\\Users\\me\\Music\\', 'new.mp3')).toBe('C:\\Users\\me\\Music\\new.mp3')
  })

  it('returns the name alone when there is no directory', () => {
    expect(joinPath('', 'new.mp3')).toBe('new.mp3')
  })

  it('round-trips with dirOf', () => {
    for (const path of ['/a/b/song.mp3', 'C:\\a\\b\\song.mp3']) {
      expect(joinPath(dirOf(path), 'other.mp3')).toBe(
        path.slice(0, path.lastIndexOf(path.includes('\\') ? '\\' : '/') + 1) + 'other.mp3',
      )
    }
  })
})
