// A user pause is signalled through an `AbortSignal`. Reading it through a function (instead
// of `signal?.aborted === true` inline) keeps TypeScript from narrowing the property to `false`
// after an earlier check: the signal changes asynchronously, across awaits.
export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
