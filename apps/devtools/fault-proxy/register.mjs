// Registers ts-hooks.mjs. Used as `node --experimental-strip-types --import <this file> …`.
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);
