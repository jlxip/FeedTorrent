import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout} from 'node:timers/promises';
const exec = promisify(execFile);

// A private test volume can remain briefly busy after its client has exited.
// Retry only EBUSY; never force an unmount or conceal a persistent cleanup error.
export async function detachImage(mount) {
  for (let attempt = 1; ; attempt++) {
    try {
      await exec('hdiutil', ['detach', mount]);
      return;
    } catch (error) {
      if (error.code !== 16 || attempt === 5) throw error;
      console.error(`Test disk image busy; waiting to detach (${attempt}/5): ${mount}`);
      await setTimeout(1000);
    }
  }
}
