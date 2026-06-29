import { describe, it, expect } from "vitest";
import { NodePtyHost, makeDefaultSpawn, type RawPty } from "../src/backends/pty";

function makeStubPty() {
  return {
    file: "", args: [] as string[], opts: null as any,
    dataCb: null as null | ((d: string) => void),
    exitCb: null as null | ((e: { exitCode: number }) => void),
    writes: [] as string[], resizes: [] as [number, number][], killed: false,
    onData(cb: (d: string) => void) { this.dataCb = cb; },
    onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb; },
    write(d: string) { this.writes.push(d); },
    resize(c: number, r: number) { this.resizes.push([c, r]); },
    kill() { this.killed = true; },
  };
}

describe("NodePtyHost", () => {
  it("maps argv/opts to the spawn function and wires the handle", () => {
    const stub = makeStubPty();
    const spawn = (file: string, args: string[], opts: any): RawPty => {
      stub.file = file; stub.args = args; stub.opts = opts; return stub as unknown as RawPty;
    };
    const host = new NodePtyHost(spawn);
    const received: string[] = [];
    let exitCode = -1;
    const h = host.spawn(["bash", "-lc", "echo hi"], { cwd: "/wt", env: { K: "v" }, cols: 100, rows: 30 });
    h.onData((d) => received.push(d));
    h.onExit((c) => { exitCode = c; });

    expect(stub.file).toBe("bash");
    expect(stub.args).toEqual(["-lc", "echo hi"]);
    expect(stub.opts.cwd).toBe("/wt");
    expect(stub.opts.cols).toBe(100);
    expect(stub.opts.rows).toBe(30);
    expect(stub.opts.env.K).toBe("v");

    stub.dataCb!("hello");
    h.write("ls\n"); h.resize(120, 40); h.kill();
    stub.exitCb!({ exitCode: 7 });

    expect(received).toEqual(["hello"]);
    expect(stub.writes).toEqual(["ls\n"]);
    expect(stub.resizes).toEqual([[120, 40]]);
    expect(stub.killed).toBe(true);
    expect(exitCode).toBe(7);
  });

  it("defaults cols/rows when omitted", () => {
    const stub = makeStubPty();
    const host = new NodePtyHost((f, a, o) => { stub.opts = o; return stub as unknown as RawPty; });
    host.spawn(["bash"], {});
    expect(stub.opts.cols).toBe(80);
    expect(stub.opts.rows).toBe(24);
  });
});

describe("makeDefaultSpawn", () => {
  it("requires node-pty from the plugin's node_modules by absolute path", () => {
    const calls: string[] = [];
    (globalThis as any).window = {
      require: (id: string) => {
        calls.push(id);
        if (id.includes("node_modules")) {
          return { spawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) };
        }
        if (id === "path") return { join: (...p: string[]) => p.join("/") };
        throw new Error(`unexpected require ${id}`);
      },
    };
    const spawn = makeDefaultSpawn("/vault/.obsidian/plugins/oawm");
    spawn("bash", [], { name: "xterm-color", cols: 80, rows: 24 } as any);
    expect(calls).toContain("/vault/.obsidian/plugins/oawm/node_modules/node-pty");
    delete (globalThis as any).window;
  });
});
