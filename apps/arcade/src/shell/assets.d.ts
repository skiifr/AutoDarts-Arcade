/** Metro turns asset imports into sources React Native understands. */
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';
  const source: ImageSourcePropType;
  export default source;
}

declare module '*.ttf' {
  import type { FontSource } from 'expo-font';
  const source: FontSource;
  export default source;
}
