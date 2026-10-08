// A counting semaphore: at most `size` tasks hold a slot at once, the rest
// wait their turn in order. The runner shares one between every AI judge
// call and every `parallel: true` rule, so "how much runs at once" is one
// number rather than a product of per-rule limits.
export function createPool(size = Infinity) {
  let free = size;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free += 1;
  };
  return {
    async run(task) {
      if (free > 0) free -= 1;
      else await new Promise((resolve) => waiting.push(resolve));
      try {
        return await task();
      } finally {
        release();
      }
    }
  };
}
