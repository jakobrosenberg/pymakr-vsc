const { existsSync, readFileSync, readdirSync, cpSync } = require("fs");
const { relative, resolve, dirname, join } = require("path");
const { inspect } = require("util");

const TEMPLATES_PATH = resolve(__dirname, "../../templates");

/**
 * creates a function that can only be called once
 * @param {function} fn
 * @param {object} context
 * @returns
 */
const once = (fn, context) => {
  let expired = false;
  let result;
  return (...args) => {
    if (!expired) result = context ? fn.apply(context, args) : fn(...args);
    expired = true;
    return result;
  };
};

/**
 * Checks if a dir has existing files.
 * @param {string} path
 * @param {string[]} ignore
 * @returns {Boolean}
 */
const hasExistingFiles = (path, ignore = []) => !!readdirSync(path).filter((file) => !ignore.includes(file)).length;

/**
 * if the input isn't an array, an array will be returned containing the input
 * if the input is an array, the input will be returned
 * @template T
 * @param {T|T[]} input
 * @returns {T[]}
 */
const coerceArray = (input) => (Array.isArray(input) ? input : [input]);

/**
 * Promise wrapper with a time allowance. If the time runs out, the fallback action or error will be returned
 * @example literal time allowance
 * const body = await waitFor(fetchFile('hello.txt'), 3000, 'file failed to fetch in 3 seconds.')
 * @example promise time allowance
 * const promise = new Promise(resolve => setTimeout(resolve, 3000))
 * const body = await waitFor(fetchFile('hello.txt'), promise, 'file failed to fetch in 3 seconds.')
 * // throws error
 * @example fallback action
 * const body = await waitFor(fetchFile('hello.txt'), 3000, ()=>'hello world.')
 * console.log(body) // hello world.
 * // throws error
 * @template T, F
 * @param {Promise<T>} primaryPromise
 * @param {number | promise} timeAllowance if resolved before the primary promise, will call fallbackActionOrError
 * @param {string | Error | (()=>(F|Promise<F>))} fallbackActionOrErr if string or error, will return rejection. If function, will return resolved function
 * @returns {Promise<T | F>} if timeAllowance has expired, will return the resolved fallbackActionOrError, otherwise returns the resolved primaryPromise
 */
const waitFor = async (primaryPromise, timeAllowance, fallbackActionOrErr) => {
  // create a fallback promise that runs after the provided time
  const fallbackPromise = new Promise((res, rej) => {
    const action =
      typeof fallbackActionOrErr != "function"
        ? () => rej(fallbackActionOrErr)
        : async () => {
            try {
              const result = await fallbackActionOrErr();
              res(result);
            } catch (err) {
              rej(err);
            }
          };

    if (typeof timeAllowance === "number") {
      const timeout = setTimeout(action, timeAllowance);
      primaryPromise.then(() => clearTimeout(timeout));
    } else {
      let resolved = false;
      primaryPromise.finally(() => (resolved = true));
      timeAllowance.finally(() => !resolved && action());
    }
  });

  return Promise.race([primaryPromise, fallbackPromise]);
};

/**
 * Coerce functions to {dispose: function}
 * Objects with a dispose property will be returned as is
 * @template {(()=>any)|{dispose: ()=>any}} T
 * @param {T} fn
 * @returns {{dispose: ()=>any}}
 */
const coerceDisposable = (fn) => {
  if (fn instanceof Function) return { dispose: fn };
  else if (fn.dispose) return fn;
  else throw new Error("fn must be a function or an object with a dispose property");
};

/**
 * gets symmetrical difference between two arrays
 * @param {any[]} arrA
 * @param {any[]} arrB
 * @returns {[any[],any[]]}
 */
const getDifference = (arrA, arrB) => [
  arrA.filter((val) => !arrB.includes(val)),
  arrB.filter((val) => !arrA.includes(val)),
];

const mapEnumsToQuickPick = (descriptions) => (_enum, index) => ({
  label: _enum,
  description: descriptions[index],
});

/**
 * Returns a cloned object with cherry picked props
 * @template T
 * @template {(keyof T)} K
 * @param {T} obj
 * @param {K[]} props
 * @returns {{[P in K]: T[P]}}
 */
const cherryPick = (obj, props) =>
  props.reduce((newObj, key) => ({ ...newObj, [key]: obj[key] }), /** @type {obj} */ ({}));

/**
 * Curried function. Returns the nearest parent from an array of folders
 * as the path is resolved, it should be in the correct format for the platform (windows/posix)
 * @param {string[]} parents
 * @returns {(child:string)=>string}
 */
const getNearestParent = (parents) => {
  const findLongest = (a, b) => (a.length > b.length ? a : b);
  const _parents = parents.map((p) => resolve(p));
  /**
   * @param {string} child
   */
  return (child) => {
    const _child = resolve(child);
    return _parents.filter((p) => _child.startsWith(p)).reduce(findLongest);
  };
};

/**
 * Curried function. Returns the relative path from the nearest provided parent
 * @param {string[]} parents array of file paths
 * @returns {(child:string)=>string}
 */
const getRelativeFromNearestParent = (parents) => (child) => {
  const nearestParent = getNearestParent(parents)(child);
  return relative(nearestParent, child);
};

/**
 * Curried function.Returns the relative posix path from the nearest provided parent
 * @param {string[]} parents
 * @returns {(child:string)=>string}
 */
const getRelativeFromNearestParentPosix = (parents) => (child) =>
  getRelativeFromNearestParent(parents)(child).replace(/\\/g, "/");

/**
 * reads a json file
 * @param {string} path
 * @returns {Object.<string|number, any>}
 */
const readJsonFile = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * resolves the nearest pymakr.conf
 * @param {string} path
 * @returns {PymakrConfFile}
 */
const getNearestPymakrConfig = (path) => {
  if (!path) return null;
  const projectPath = getNearestPymakrProjectDir(path);
  if (projectPath) return readJsonFile(join(projectPath, "pymakr.conf"));
  else return null;
};

/**
 * resolves the path to the nearest folder containing pymakr.conf
 * @param {string} path
 * @returns {string}
 */
const getNearestPymakrProjectDir = (path) => {
  const configPath = join(path, "pymakr.conf");
  if (existsSync(configPath)) return path;
  else {
    const parentDir = dirname(path);
    if (parentDir !== path) return getNearestPymakrProjectDir(parentDir);
    else return null;
  }
};

/**
 * @example
 * arrayToRegexStr(['foo', 'bar']) === '(foo)|(bar)' //true
 * @param {(string|RegExp)[]} arr
 */
const arrayToRegexStr = (arr) => arr.map((str) => `(${str})`).join("|");

/**
 * Check if an item matches an includes or excludes array
 * @example
 * const item = {foo: 'bar'}
 * const filter = createIsIncluded(['.*'],['bar'], item => JSON.stringify(item))
 * filter(item) // returns false as item matches exclude
 * @param {(string|RegExp)[]} includes
 * @param {(string|RegExp)[]} excludes
 * @param {(item:any) => (string)} cb optional callback to transform the item in the curried function
 * @returns
 */
const createIsIncluded = (includes, excludes, cb = (x) => x) => {
  const incRegex = new RegExp(arrayToRegexStr(includes), "gi");
  const excRegex = new RegExp(arrayToRegexStr(excludes), "gi");
  return (item) => {
    const str = cb(item);
    return incRegex.test(str) && (!excludes.length || !excRegex.test(str));
  };
};

/**
 * Serializes flat object
 * @example default behavior
 * ```javascript
 * serializeKeyValuePairs ({foo: 123, bar: 'bar'})
 * // foo=123
 * // bar=bar
 * ```
 * @param {any} obj
 * @param {string=} equalSign
 * @param {string=} delimiter
 * @returns
 */
const serializeKeyValuePairs = (obj, equalSign = "=", delimiter = "\r\n") =>
  Object.entries(obj)
    .map(([key, value]) => key + equalSign + value)
    .join(delimiter);

/**
 * @returns {Promise<any> & {resolve: function, reject: function}}
 */
const resolvablePromise = () => {
  let resolve, reject;
  const origPromise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  return Object.assign(origPromise, { resolve, reject });
};

/**
 * Subsequent calls to an active throttled function will return the same promise as the first call.
 * A function is active until it's first call is resolved
 * @template {Function} T
 * @param {T} fn callback
 * @param {number=} time leave at 0 to only throttle calls made within the same cycle
 * @returns {(...params: Parameters<T>)=>Promise<ReturnType<T>>}
 */
const createThrottledFunction = (fn, time) => {
  let isRunning = false;
  /** @type {{resolve: any, reject: any}[]} */
  const subs = [];
  const fnWrapper = (...params) =>
    new Promise((resolve, reject) => {
      subs.push({ resolve, reject });
      if (!isRunning) {
        isRunning = true;
        setTimeout(async () => {
          this._isRefreshingProviders = false;
          try {
            const result = await fn(...params);
            subs.forEach((sub) => sub.resolve(result));
          } catch (err) {
            subs.forEach((sub) => sub.reject(err));
          }
          subs.splice(0);
          isRunning = false;
        }, time);
      }
    });
  return fnWrapper;
};

const getTemplates = () => readdirSync(TEMPLATES_PATH).map((name) => ({ name, path: resolve(TEMPLATES_PATH, name) }));
const copyTemplateByName = (name, destination, overwrite) =>
  copyTemplateByPath(resolve(TEMPLATES_PATH, name), destination, overwrite);
const copyTemplateByPath = (path, destination, overwrite) =>
  cpSync(path, destination, { recursive: true, force: overwrite });

/**
 * converts {foo:FOO, bar:BAR} to ['foo=FOO', 'bar=BAR']
 * @param {Object} obj
 */
const objToSerializedEntries = (obj) => Object.entries(obj).map((entr) => entr.join("="));

/**
 * converts ['foo=FOO', 'bar=BAR'] to {foo:FOO, bar:BAR}
 * @param {string[]} serializedEntries
 */
const serializedEntriesToObj = (serializedEntries) => Object.fromEntries(serializedEntries.map((n) => n.split("=")));

/**
 * Creates an array of promises. The array only supports push.
 * Every time all promises have been resolved the callback is called
 * @param {Function} callback called every time promises are resolved
 */
const onResolveAll = (callback) => {
  /** @type {Promise<any>} */
  let promisePyramid = null;

  let claim = null;

  return {
    /** @param {Promise<any>} promise */
    async push(promise) {
      const id = Symbol();
      claim = id;
      promisePyramid = Promise.all([promisePyramid, promise]);
      await promisePyramid;
      if (claim === id) callback();
    },
  };
};

/**
 * @param {Promise<any>[]} promises
 */
const dynamicPromiseAll = async (promises) => {
  const result = await Promise.all(promises);
  const hasPending = promises.map((promise) => inspect(promise).includes("pending")).filter(Boolean).length;
  return hasPending ? dynamicPromiseAll(promises) : result;
};

/**
 * Returns a cloned project with cherry picked props
 * @param {Object} obj
 * @param  {...string} props
 */
const pick = (obj, ...props) => props.reduce((result, prop) => ({ ...result, [prop]: obj[prop] }), {});

/**
 * returns a cloned object with props omitted
 * @param {Object} obj
 * @param  {...string} props
 */
const omit = (obj, ...props) => props.reduce((result, prop) => delete result[prop] && result, { ...obj });

/**
 * Creates a queue
 * Calling the queue will return a promise.
 * The promise contains a function to be called once the next item in the queue can be run.
 * @example
 * const queue = createQueue()
 * // ...
 * const imDone = await queue()
 * await anAsyncCall()
 * imDone()
 */
const createQueue = () => {
  /** @type {(function)[]} */
  const queue = [];
  let isRunning;
  const runQueue = async () => {
    if (!isRunning) {
      isRunning = true;
      while (queue.length) {
        await new Promise((resolve) => {
          const entry = queue.shift();
          entry(resolve);
        });
      }
      isRunning = false;
    }
  };

  /** @returns {Promise<imDone>} */
  return () =>
    new Promise((resolve) => {
      queue.push(resolve);
      runQueue();
    });
};

/**
 * Call this function to start the next item in the queue
 * @callback imDone
 */

module.exports = {
  hasExistingFiles,
  dynamicPromiseAll,
  onResolveAll,
  objToSerializedEntries,
  serializedEntriesToObj,
  once,
  coerceArray,
  waitFor,
  coerceDisposable,
  getDifference,
  mapEnumsToQuickPick,
  cherryPick,
  getNearestParent,
  getRelativeFromNearestParent,
  getRelativeFromNearestParentPosix,
  getNearestPymakrConfig,
  getNearestPymakrProjectDir,
  serializeKeyValuePairs,
  createIsIncluded,
  arrayToRegexStr,
  resolvablePromise,
  createThrottledFunction,
  getTemplates,
  copyTemplateByName,
  copyTemplateByPath,
  pick,
  omit,
  createQueue,
};
