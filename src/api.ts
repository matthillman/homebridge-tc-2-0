import { Logger } from 'homebridge/lib/logger';
import { HKArmState, TCApi } from './tc.v2';

let api = new TCApi(Logger.withPrefix(`TC`), {
  username: 'user',
  password: 'password',
});

const run = async () => {
  try {
    // const state = await api.getStatus();
    const state = await api.armSystem(HKArmState.DISARM);
    console.log(`got status`, state);
  } catch (err) {
    console.error(`[ERROR] ${err}`);
  }
}

run();
