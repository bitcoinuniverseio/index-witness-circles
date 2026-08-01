import { ValueTransformer } from 'typeorm';

export const bigintTransformer: ValueTransformer = {
  to(value: bigint | null | undefined): string | null | undefined {
    return value === null || value === undefined ? value : value.toString();
  },
  from(value: string | number | null): bigint | null {
    return value === null ? null : BigInt(value);
  },
};
