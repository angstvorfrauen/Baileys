//===================================//
export const makeMutex = () => {
  let task = Promise.resolve();
  let taskTimeout;
  return {
    mutex(code) {
      task = (async () => {
        try {
          await task;
        }
        catch { }
        try {
          const result = await code();
          return result;
        }
        finally {
          clearTimeout(taskTimeout);
        }
      })();
      return task;
    }
  };
};
//===================================//
export const makeKeyedMutex = () => {
  const map = {};
  return {
    mutex(key, task) {
      if (!map[key]) {
        map[key] = makeMutex();
      }
      return map[key].mutex(task);
    }
  };
};
//===================================//