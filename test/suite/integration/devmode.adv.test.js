const assert = require("assert");
const { existsSync, writeFileSync } = require("fs");
const { join } = require("path");
const vscode = require("vscode");

const projectPath1 = join(workspaceDir, "project-1");
/** @type {Project} */
let project;
/** @type {Device} */
let device;

const readUntil = (string) => new Promise((resolve) => device.readUntil(string, resolve));

beforeAll(async () => {
  // Create a project and add a device
  // todo should createProject resolve promise only once project is added to projectsStore?
  await pymakr.commands.createProject(vscode.Uri.parse(projectPath1), {
    name: "my project",
    dev: { simulateDeepSleep: true },
  });
  await new Promise((resolve) => pymakr.projectsStore.next(resolve));
  project = pymakr.projectsStore.get()[0];
  device = pymakr.devicesStore.get()[0];
  project.setDevices([device]);
  assert(existsSync(projectPath1));
  assert.equal(project.name, "my project");
  assert(device);
});

test("can fake deepsleep in devmode", async () => {
  test("can put project in dev mode", async () => {
    await device.connect();
    // await pymakr.commands.eraseDevice({ device }, "empty");
    // device.onTerminalData((data) => console.log("data", data));
    await pymakr.commands.startDevMode({ project });
    assert(project.watcher.active);
    assert.equal(project.watcher.deviceManagers.length, 1);
  });
  test("first save in devmode install devtools and restarts", async () => {
    writeFileSync(projectPath1 + "/main.py", 'print("hello world")');
    await readUntil("uploading Pymakr devtools");
    await readUntil("patching boot.dev");
    await readUntil("changed. Restarting...");
    await readUntil(">>>");
    await readUntil(">>>");
    console.log("after reset");

    test("sys.path includes _pymakr_dev", async () => {
      console.log("before sys check");
      const result = await device.runScript("import sys\nprint(sys.path)");
      assert(result.match(/\/_pymakr_dev/), "did not find _pymakr_dev. Found: " + result.toString());
    });

    test("pymakr_dev/fake_machine.py exists on device", async () => {
      const result = await device.runScript("print(os.listdir('_pymakr_dev'))");
      assert(result.match("fake_machine.py"));
    });

    test("can import fake_machine in devmode", async () => {
      const result = await device.runScript("import fake_machine\nfake_machine.sleep(1)");
      console.log("result", result);
    });
  });
});
