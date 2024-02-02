import { Contract } from '@algorandfoundation/tealscript';

type PluginsKey = { application: Application; allowedCaller: Address };

export class AbstractedAccount extends Contract {
  /** Target AVM 10 */
  programVersion = 10;

  /** The admin of the abstracted account */
  admin = GlobalStateKey<Address>();

  /**
   * The apps and addresses that are authorized to send itxns from the abstracted account,
   * The key is the appID + address, the value (referred to as `end`)
   * is the timestamp when the permission expires for the address to call the app for your account.
   */

  plugins = BoxMap<PluginsKey, uint64>({ prefix: 'p' });

  /**
   * Plugins that have been given a name for discoverability
   */
  namedPlugins = BoxMap<bytes, PluginsKey>({ prefix: 'n' });

  /** The address this app controls */
  controlledAddress = GlobalStateKey<Address>();

  /**
   * Ensure that by the end of the group the abstracted account has control of its address
   */
  private verifyRekeyToAbstractedAccount(): void {
    const lastTxn = this.txnGroup[this.txnGroup.length - 1];

    // If the last txn isn't a rekey, then assert that the last txn is a call to verifyAuthAddr
    if (lastTxn.sender !== this.controlledAddress.value || lastTxn.rekeyTo !== this.getAuthAddr()) {
      verifyAppCallTxn(lastTxn, {
        applicationID: this.app,
        applicationArgs: {
          0: method('arc58_verifyAuthAddr()void'),
        },
      });
    }
  }

  /**
   * What the value of this.address.value.authAddr should be when this.address
   * is able to be controlled by this app. It will either be this.app.address or zeroAddress
   */
  private getAuthAddr(): Address {
    return this.controlledAddress.value === this.app.address ? Address.zeroAddress : this.app.address;
  }

  /**
   * Create an abstracted account application
   *
   * @param controlledAddress The address of the abstracted account. If zeroAddress, then the address of the contract account will be used
   * @param admin The admin for this app
   */
  createApplication(controlledAddress: Address, admin: Address): void {
    verifyAppCallTxn(this.txn, {
      sender: { includedIn: [controlledAddress, admin] },
    });

    assert(admin !== controlledAddress);

    this.admin.value = admin;
    this.controlledAddress.value = controlledAddress === Address.zeroAddress ? this.app.address : controlledAddress;
  }

  /**
   * Verify the abstracted account is rekeyed to this app
   */
  arc58_verifyAuthAddr(): void {
    assert(this.controlledAddress.value.authAddr === this.getAuthAddr());
  }

  /**
   * Rekey the abstracted account to another address. Primarily useful for rekeying to an EOA.
   *
   * @param addr The address to rekey to
   * @param flash Whether or not this should be a flash rekey. If true, the rekey back to the app address must done in the same txn group as this call
   */
  arc58_rekeyTo(addr: Address, flash: boolean): void {
    verifyAppCallTxn(this.txn, { sender: this.admin.value });

    sendPayment({
      sender: this.controlledAddress.value,
      receiver: addr,
      rekeyTo: addr,
      note: 'rekeying abstracted account',
    });

    if (flash) this.verifyRekeyToAbstractedAccount();
  }

  /**
   * Temporarily rekey to an approved plugin app address
   *
   * @param plugin The app to rekey to
   */
  arc58_rekeyToPlugin(plugin: Application): void {
    const globalKey: PluginsKey = { application: plugin, allowedCaller: globals.zeroAddress };

    // If this plugin is not approved globally, then it must be approved for this address
    if (!this.plugins(globalKey).exists || this.plugins(globalKey).value < globals.latestTimestamp) {
      const key: PluginsKey = { application: plugin, allowedCaller: this.txn.sender };
      assert(this.plugins(key).exists && this.plugins(key).value > globals.latestTimestamp);
    }

    sendPayment({
      sender: this.controlledAddress.value,
      receiver: this.controlledAddress.value,
      rekeyTo: plugin.address,
      note: 'rekeying to plugin app',
    });

    this.verifyRekeyToAbstractedAccount();
  }

  /**
   * Temporarily rekey to a named plugin app address
   *
   * @param name The name of the plugin to rekey to
   */
  arc58_rekeyToNamedPlugin(name: string): void {
    this.arc58_rekeyToPlugin(this.namedPlugins(name).value.application);
  }

  /**
   * Change the admin for this app
   *
   * @param newAdmin The new admin
   */
  arc58_changeAdmin(newAdmin: Account): void {
    verifyTxn(this.txn, { sender: this.admin.value });
    assert(newAdmin !== this.controlledAddress.value);
    this.admin.value = newAdmin;
  }

  /**
   * Add an app to the list of approved plugins
   *
   * @param app The app to add
   * @param allowedCaller The address of that's allowed to call the app
   * or the global zero address for all addresses
   * @param end The timestamp when the permission expires
   */
  arc58_addPlugin(app: Application, allowedCaller: Address, end: uint64): void {
    verifyTxn(this.txn, { sender: this.admin.value });
    const key: PluginsKey = { application: app, allowedCaller: allowedCaller };
    this.plugins(key).value = end;
  }

  /**
   * Remove an app from the list of approved plugins
   *
   * @param app The app to remove
   */
  arc58_removePlugin(app: Application, allowedCaller: Address): void {
    verifyTxn(this.txn, { sender: this.admin.value });

    const key: PluginsKey = { application: app, allowedCaller: allowedCaller };
    this.plugins(key).delete();
  }

  /**
   * Add a named plugin
   *
   * @param app The plugin app
   * @param name The plugin name
   */
  arc58_addNamedPlugin(name: string, app: Application, allowedCaller: Address, end: uint64): void {
    verifyTxn(this.txn, { sender: this.admin.value });
    assert(!this.namedPlugins(name).exists);

    const key: PluginsKey = { application: app, allowedCaller: allowedCaller };
    this.namedPlugins(name).value = key;
    this.plugins(key).value = end;
  }

  /**
   * Remove a named plugin
   *
   * @param name The plugin name
   */
  arc58_removeNamedPlugin(name: string): void {
    verifyTxn(this.txn, { sender: this.admin.value });

    const app = this.namedPlugins(name).value;
    this.namedPlugins(name).delete();
    this.plugins(app).delete();
  }
}
