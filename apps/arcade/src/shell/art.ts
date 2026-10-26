import type { ImageSourcePropType } from 'react-native';
import balloon from '../../assets/art/placeholder/poster-balloon.png';
import countdown from '../../assets/art/placeholder/poster-countdown.png';
import cricket from '../../assets/art/placeholder/poster-cricket.png';
import siege from '../../assets/art/placeholder/poster-siege.png';
import territory from '../../assets/art/placeholder/poster-territory.png';

/**
 * Art slots. Every file is logged in ASSETS.md; the specs for final art are in
 * docs/design/asset-spec.md. The current posters are TEMPORARY placeholders cropped from the
 * concept mockup. A game with no poster here gets the vector PosterArt from the ui-kit.
 */
export const POSTER_IMAGES: Partial<Record<string, ImageSourcePropType>> = {
  siege,
  territory,
  balloon,
  countdown,
  cricket,
};

/** Painted stage backgrounds (slot `stage-siege-bg`). None yet: the stage draws vector art. */
export const STAGE_BACKGROUNDS: Partial<Record<string, ImageSourcePropType>> = {};

/**
 * Invader sprites, one per type, each with a BLANK shield; the app writes the live number and
 * strength pips on top (slots `siege-invader-a/b/c` and their `-damaged` variants). None yet:
 * the stage draws them in SVG.
 */
export const INVADER_SPRITES: readonly { intact: ImageSourcePropType; damaged?: ImageSourcePropType }[] = [];

/** Illustrated avatars, if the owner picks them (slots `avatar-01`…`avatar-16`). None yet. */
export const AVATAR_IMAGES: readonly ImageSourcePropType[] = [];
