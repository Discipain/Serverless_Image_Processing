import { ImageCard } from './ImageCard';

export function GalleryGrid({ images }) {
  return (
    <ul className="gallery-grid">
      {images.map((image) => (
        <li key={image.imageId}>
          <ImageCard image={image} />
        </li>
      ))}
    </ul>
  );
}
