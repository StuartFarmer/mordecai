declare module 'z32' {
  const z32: {
    encode(buffer: Uint8Array): string;
    decode(value: string): Uint8Array;
  };
  export default z32;
}
