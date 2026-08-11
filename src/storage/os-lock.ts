import { join } from "@std/path";

/**
 * A process-scoped advisory lock held by a tiny Perl helper.  The kernel owns
 * the lock: a dead helper releases it automatically, and the helper exits if
 * its Deno parent disappears.  This deliberately avoids timestamp-based owner
 * liveness, which is unsafe after suspend, clock changes, or a crashed owner.
 */
export class OsLock {
  private constructor(private readonly child: Deno.ChildProcess) {}

  static async acquire(directory: string, name: string): Promise<OsLock | undefined> {
    await Deno.mkdir(directory, { recursive: true });
    const path = join(directory, `${name}.lock`);
    const program = [
      "use Fcntl qw(:flock);",
      "my ($path, $parent) = @ARGV;",
      "open(my $fh, '>>', $path) or die \"open lock: $!\";",
      "flock($fh, LOCK_EX | LOCK_NB) or exit 75;",
      '$| = 1; print "locked\\n";',
      "while (getppid() == $parent) { sleep 1; }",
    ].join(" ");
    const child = new Deno.Command("perl", {
      args: ["-e", program, path, String(Deno.pid)],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const reader = child.stdout.getReader();
    let first: ReadableStreamReadResult<Uint8Array>;
    try {
      first = await reader.read();
    } finally {
      reader.releaseLock();
    }
    const signal = first.done ? "" : new TextDecoder().decode(first.value);
    if (signal === "locked\n") return new OsLock(child);
    await child.status.catch(() => undefined);
    return undefined;
  }

  async release(): Promise<void> {
    try {
      this.child.kill("SIGTERM");
    } catch {
      // It may already have observed its parent terminating or been killed.
    }
    await this.child.status.catch(() => undefined);
  }
}

export async function isOsLockHeld(directory: string, name: string): Promise<boolean> {
  const lock = await OsLock.acquire(directory, name);
  if (!lock) return true;
  await lock.release();
  return false;
}
