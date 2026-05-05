/* Ambient declaration so this package's TypeScript build can resolve
   `import { ... } from 'enchanter'` without pulling root sources through
   this package's rootDir. At consume-time, types resolve from the
   consumer's installed `enchanter` package. */

declare module 'enchanter' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const sylphAdapter: any;
}
