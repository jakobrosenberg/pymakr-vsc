const { dirname } = require("path");
const { readFileSync, statSync, readdirSync } = require("fs");
const { MicroPythonDevice } = require("micropython-ctl-cont");
const { createBlockingProxy } = require("./utils/blockingProxy");
const { waitFor, cherryPick, getRelativeFromNearestParentPosix } = require("./utils/misc");
const { writable } = require("./utils/store");
const vscode = require("vscode");
const { createDeviceConfigStore } = require("./stores/deviceConfig");

class Device {
  /**
   * @param {PyMakr} pymakr
   * @param {DeviceInput} deviceInput
   */
  constructor(pymakr, deviceInput) {
    const { subscribe, set } = writable(this);
    this.subscribe = subscribe;
    /** call whenever device changes need to be onChanged to subscriptions */
    this.changed = () => set(this);
    const { address, name, protocol, raw, password } = deviceInput;
    this.pymakr = pymakr;
    this.protocol = protocol;
    this.address = address;
    this.password = password;
    this.name = name;
    this.raw = raw;

    this.connected = false;
    this.connecting = false;
    this.online = false;
    this.lostConnection = false;

    this.config = createDeviceConfigStore(this);

    /** `${protocol}://${address}` */
    this.id = `${protocol}://${address}`;
    this.log = pymakr.log.createChild("Device: " + this.name);
    this.adapter = this.createAdapter();
    /** @type {import("micropython-ctl").BoardInfo} */
    this.info = null;

    this.updateConnection();
    subscribe(() => this.onChanged());
  }

  async updateConnection() {
    if (this.online && !this.connected) {
      const autoConnect = this.config.get().autoConnect || this.pymakr.config.get().get("autoConnect");
      const shouldConnect = autoConnect === "always";
      const shouldResume = autoConnect === "lastState" && this.loadState().connected;
      const shouldReconnect = autoConnect === "onLostConnection" && this.lostConnection;
      if (shouldConnect || shouldResume || shouldReconnect) await this.connect();
    } else {
      this.lostConnection = this.lostConnection || this.connected;
      this.connected = false;
      this.changed();
    }
  }

  /**
   *
   * @param {string} script
   * @param {import("micropython-ctl-cont").RunScriptOptions} options
   * @returns
   */
  async runScript(script, options) {
    /** @type {import("micropython-ctl-cont").RunScriptOptions} options */
    const defaults = {
      runGcCollectBeforeCommand: true,
    };
    this.log.debugShort(`runScript:\n\n${script}\n\n`);
    const result = await this.adapter.runScript(script + "\n", Object.assign(defaults, options));
    this.log.debugShort(`script returned:\n\n${result}\n\n`);
    return result;
  }

  createAdapter() {
    const rawAdapter = new MicroPythonDevice();
    // We need to wrap the rawAdapter in a blocking proxy to make sure commands
    // run in sequence rather in in parallel. See JSDoc comment for more info.
    return createBlockingProxy(rawAdapter, { exceptions: ["sendData"] });
  }

  __connectingPromise = null;

  async connect() {
    if (!this.connecting) {
      this.connecting = true;
      this.__connectingPromise = new Promise(async (resolve, reject) => {
        if (this.protocol === "serial") {
          try {
            this.log.info("connecting...");
            const connectPromise = this.adapter.connectSerial(this.address);
            await waitFor(connectPromise, 2000, "Timed out while connecting.");
            this.connected = true;
            this.lostConnection = false;
            this.changed();
            this.log.info("connected.");
            this.info = await waitFor(this.adapter.getBoardInfo(), 10000, "timed out while getting board info");
            this.log.debug("boardInfo", this.info);
            await this.pymakr.activeDeviceStore.setToLastUsedOrFirstFound();
            resolve();
          } catch (err) {
            const error = [`Failed to connect to ${this.address}.`, err.message, this.adapter];
            vscode.window.showErrorMessage(
              [error[0], err.message, "Please see developer logs for more info."].join(" - ")
            );
            this.log.error(...error);
            reject(err);
          }
        }
      });
      this.connecting = false;
    }
    return this.__connectingPromise;
  }
  async disconnect() {
    const connectPromise = this.adapter.disconnect();
    await waitFor(connectPromise, 2000, "Timed out while disconnecting.");
    this.connected = false;
    this.lostConnection = false;
    this.changed();
  }

  saveState() {
    return this.handleState("save");
  }
  loadState() {
    return this.handleState("load");
  }
  handleState(action) {
    const key = `pymakr.devices.${this.id}.state`;
    const { workspaceState } = this.pymakr.context;

    if (action === "save") {
      const currentState = cherryPick(this, ["connected", "name"]);
      workspaceState.update(key, currentState);
    }

    const state = workspaceState.get(key);
    this.log.debugShort("handleState", action, state);
    return state || {};
  }

  onChanged() {
    this.saveState();
    this.pymakr.devicesProvider.refresh();
    this.pymakr.projectsProvider.refresh();
  }

  async _uploadFile(file, destination) {
    const _destination = `/flash/${destination}`.replace(/\/+/g, "/");
    const destinationDir = dirname(_destination);
    this.log.traceShort("uploadFile", file, "to", _destination);
    const data = Buffer.from(readFileSync(file));
    // todo move mkdir logic to micropython-ctl-cont
    try {
      await this.adapter.mkdir(destinationDir);
    } catch (err) {
      if (!err.message.match("OSError: \\[Errno 17\\] EEXIST")) throw err;
    }
    return this.adapter.putFile(_destination, data, { checkIfSimilarBeforeUpload: true });
  }

  async _uploadDir(dir, destination) {
    for (const file of readdirSync(dir)) await this._upload(`${dir}/${file}`, `${destination}/${file}`);
  }

  _upload(source, destination) {
    return statSync(source).isDirectory()
      ? this._uploadDir(source, destination)
      : this._uploadFile(source, destination);
  }

  /**
   * Uploads file or folder to device
   * @param {string} source
   * @param {string} destination
   */
  async upload(source, destination) {
    // todo move tight coupled vscode
    try {
      this.log.info("copy from", source, "to", destination);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (progress) => {
        progress.report({ message: `copy to ${this.name}` });
        this.log.info("upload", source, "to", destination);
        await this._upload(source, destination);
        this.log.info("upload completed");
      });
    } catch (err) {
      const errors = ["failed to upload", source, "to", destination, "\r\nReason:", err];
      vscode.window.showErrorMessage(errors.join(" "));
      this.log.error(errors);
    }
  }
}

module.exports = { Device };
