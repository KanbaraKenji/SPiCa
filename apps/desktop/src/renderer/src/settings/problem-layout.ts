// Where a field's problem is said without moving the box (he found red text under the box shifts it). Two ways
// for him to pick between; this constant goes once he has.
//   beside-label: the box only turns red; the words go after the field's name, on its line.
//   in-box: the box turns red and the words sit inside it, at its right end; the 保存 row says how many.
export const PROBLEM_LAYOUT: 'beside-label' | 'in-box' = 'beside-label';
