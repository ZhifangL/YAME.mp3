// Shared "no cover art" placeholder using default-album-art-square.svg.
import defaultArt from '../assets/default-album-art-square.svg'

export function MusicArt() {
  return <img src={defaultArt} alt="" className="default-art" draggable={false} />
}
