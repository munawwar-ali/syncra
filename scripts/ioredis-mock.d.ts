// ioredis-mock ships no types that resolve under NodeNext; it is API-compatible with ioredis.
declare module 'ioredis-mock' {
  import type { Redis } from 'ioredis';
  const RedisMock: new (...args: unknown[]) => Redis;
  export default RedisMock;
}
