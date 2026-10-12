import { describe, it, expect } from 'vitest';
import {
  mul3, mulVec3, transpose3, det3, inv3, identity3, cross3, dot3, norm3, normalize3,
  fromCols3, col3,
} from '../src/math/linalg.js';

const close = (A, B, digits = 9) => {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(A[i][j]).toBeCloseTo(B[i][j], digits);
};

describe('linalg', () => {
  const A = [[2, 1, 0], [0, 3, 1], [1, 0, 4]];

  it('乘法、转置、行列式', () => {
    close(mul3(A, identity3()), A);
    expect(mulVec3(A, [1, 2, 3])).toEqual([4, 9, 13]);
    expect(transpose3(A)[0]).toEqual([2, 0, 1]);
    expect(det3(A)).toBeCloseTo(25, 12);
  });

  it('求逆：A·A⁻¹ = I', () => {
    close(mul3(A, inv3(A)), identity3());
  });

  it('奇异矩阵抛出异常', () => {
    expect(() => inv3([[1, 2, 3], [2, 4, 6], [0, 0, 1]])).toThrow();
  });

  it('向量运算', () => {
    expect(cross3([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(dot3([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(norm3([3, 4, 12])).toBe(13);
    expect(norm3(normalize3([5, -2, 7]))).toBeCloseTo(1, 12);
  });

  it('按列拼装与取列', () => {
    const M = fromCols3([1, 2, 3], [4, 5, 6], [7, 8, 9]);
    expect(col3(M, 1)).toEqual([4, 5, 6]);
    expect(M[2]).toEqual([3, 6, 9]);
  });
});
