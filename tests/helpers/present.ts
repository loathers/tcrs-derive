/**
 * Narrow away a `T | undefined | null`, failing loudly if it really is absent.
 *
 * Tests index into records and arrays constantly, and tsconfig's
 * noUncheckedIndexedAccess makes every one of those `T | undefined`. A `!` silences
 * that with no runtime consequence: when the assumption is wrong the test fails
 * later, somewhere else, reading "cannot read properties of undefined". This fails
 * at the lookup instead, which is where the mistake actually is.
 */
export function present<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error(`expected a value to be present, got ${String(value)}`);
	}
	return value;
}
