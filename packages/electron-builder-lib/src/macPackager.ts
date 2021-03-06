import BluebirdPromise from "bluebird-lst"
import { deepAssign, Arch, AsyncTaskManager, exec, InvalidConfigurationError, log } from "builder-util"
import { signAsync, SignOptions } from "electron-osx-sign"
import { ensureDir, readdir, remove } from "fs-extra-p"
import { Lazy } from "lazy-val"
import * as path from "path"
import * as semver from "semver"
import { AsarIntegrity } from "asar-integrity"
import { asArray } from "builder-util-runtime/out"
import { AppInfo } from "./appInfo"
import { appleCertificatePrefixes, CertType, CodeSigningInfo, createKeychain, findIdentity, Identity, isSignAllowed, reportError } from "./codeSign"
import { DIR_TARGET, Platform, Target } from "./core"
import { MacConfiguration, MasConfiguration } from "./options/macOptions"
import { Packager } from "./packager"
import { createMacApp } from "./packager/mac"
import { chooseNotNull, PlatformPackager } from "./platformPackager"
import { ArchiveTarget } from "./targets/ArchiveTarget"
import { PkgTarget, prepareProductBuildArgs } from "./targets/pkg"
import { createCommonTarget, NoOpTarget } from "./targets/targetFactory"
import { CONCURRENCY } from "builder-util/out/fs"

export default class MacPackager extends PlatformPackager<MacConfiguration> {
  readonly codeSigningInfo = new Lazy<CodeSigningInfo>(() => {
    const cscLink = this.getCscLink()
    if (cscLink == null || process.platform !== "darwin") {
      return Promise.resolve({keychainName: process.env.CSC_KEYCHAIN || null})
    }

    return createKeychain({
      tmpDir: this.info.tempDirManager,
      cscLink,
      cscKeyPassword: this.getCscPassword(),
      cscILink: chooseNotNull(this.platformSpecificBuildOptions.cscInstallerLink, process.env.CSC_INSTALLER_LINK),
      cscIKeyPassword: chooseNotNull(this.platformSpecificBuildOptions.cscInstallerKeyPassword, process.env.CSC_INSTALLER_KEY_PASSWORD),
      currentDir: this.projectDir
    })
  })

  private _iconPath = new Lazy(() => this.getOrConvertIcon("icns"))

  constructor(info: Packager) {
    super(info, Platform.MAC)
  }

  get defaultTarget(): Array<string> {
    const electronUpdaterCompatibility = this.platformSpecificBuildOptions.electronUpdaterCompatibility
    return (electronUpdaterCompatibility == null || semver.satisfies("2.16.0", electronUpdaterCompatibility)) ? ["zip", "dmg"] : ["dmg"]
  }

  protected prepareAppInfo(appInfo: AppInfo): AppInfo {
    return new AppInfo(this.info, this.platformSpecificBuildOptions.bundleVersion)
  }

  async getIconPath(): Promise<string | null> {
    return this._iconPath.value
  }

  createTargets(targets: Array<string>, mapper: (name: string, factory: (outDir: string) => Target) => void): void {
    for (const name of targets) {
      switch (name) {
        case DIR_TARGET:
          break

        case "dmg":
          const { DmgTarget } = require("dmg-builder")
          mapper(name, outDir => new DmgTarget(this, outDir))
          break

        case "zip":
          // https://github.com/electron-userland/electron-builder/issues/2313
          mapper(name, outDir => new ArchiveTarget(name, outDir, this, true))
          break

        case "pkg":
          mapper(name, outDir => new PkgTarget(this, outDir))
          break

        default:
          mapper(name, outDir => name === "mas" || name === "mas-dev" ? new NoOpTarget(name) : createCommonTarget(name, outDir, this))
          break
      }
    }
  }

  async pack(outDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): Promise<any> {
    let nonMasPromise: Promise<any> | null = null

    const hasMas = targets.length !== 0 && targets.some(it => it.name === "mas" || it.name === "mas-dev")
    const prepackaged = this.packagerOptions.prepackaged

    if (!hasMas || targets.length > 1) {
      const appPath = prepackaged == null ? path.join(this.computeAppOutDir(outDir, arch), `${this.appInfo.productFilename}.app`) : prepackaged
      nonMasPromise = (prepackaged ? Promise.resolve() : this.doPack(outDir, path.dirname(appPath), this.platform.nodeName, arch, this.platformSpecificBuildOptions, targets))
        .then(() => this.sign(appPath, null, null))
        .then(() => this.packageInDistributableFormat(appPath, Arch.x64, targets, taskManager))
    }

    for (const target of targets) {
      const targetName = target.name
      if (!(targetName === "mas" || targetName === "mas-dev")) {
        continue
      }

      const masBuildOptions = deepAssign({}, this.platformSpecificBuildOptions, (this.config as any).mas)
      if (targetName === "mas-dev") {
        deepAssign(masBuildOptions, (this.config as any)[targetName], {
          type: "development",
        })
      }

      const targetOutDir = path.join(outDir, targetName)
      if (prepackaged == null) {
        await this.doPack(outDir, targetOutDir, "mas", arch, masBuildOptions, [target])
        await this.sign(path.join(targetOutDir, `${this.appInfo.productFilename}.app`), targetOutDir, masBuildOptions)
      }
      else {
        await this.sign(prepackaged, targetOutDir, masBuildOptions)
      }
    }

    if (nonMasPromise != null) {
      await nonMasPromise
    }
  }

  private async sign(appPath: string, outDir: string | null, masOptions: MasConfiguration | null): Promise<void> {
    if (!isSignAllowed()) {
      return
    }

    const isMas = masOptions != null
    const macOptions = this.platformSpecificBuildOptions
    const qualifier = (isMas ? masOptions!.identity : null) || macOptions.identity

    if (!isMas && qualifier === null) {
      if (this.forceCodeSigning) {
        throw new InvalidConfigurationError("identity explicitly is set to null, but forceCodeSigning is set to true")
      }
      log.info({reason: "identity explicitly is set to null"}, "skipped macOS code signing")
      return
    }

    const keychainName = (await this.codeSigningInfo.value).keychainName
    const explicitType = isMas ? masOptions!.type : macOptions.type
    const type = explicitType || "distribution"
    const isDevelopment = type === "development"
    const certificateType = getCertificateType(isMas, isDevelopment)
    let identity = await findIdentity(certificateType, qualifier, keychainName)
    if (identity == null) {
      if (!isMas && !isDevelopment && explicitType !== "distribution") {
        identity = await findIdentity("Mac Developer", qualifier, keychainName)
        if (identity != null) {
          log.warn("Mac Developer is used to sign app — it is only for development and testing, not for production")
        }
      }

      if (identity == null) {
        await reportError(isMas, certificateType, qualifier, keychainName, this.forceCodeSigning)
        return
      }
    }

    const signOptions: any = {
      "identity-validation": false,
      // https://github.com/electron-userland/electron-builder/issues/1699
      // kext are signed by the chipset manufacturers. You need a special certificate (only available on request) from Apple to be able to sign kext.
      ignore: (file: string) => {
        return file.endsWith(".kext") || file.startsWith("/Contents/PlugIns", appPath.length) ||
          // https://github.com/electron-userland/electron-builder/issues/2010
          file.includes("/node_modules/puppeteer/.local-chromium")
      },
      identity: identity!,
      type,
      platform: isMas ? "mas" : "darwin",
      version: this.config.electronVersion,
      app: appPath,
      keychain: keychainName || undefined,
      binaries: (isMas && masOptions != null ? masOptions.binaries : macOptions.binaries) || undefined,
      requirements: isMas || macOptions.requirements == null ? undefined : await this.getResource(macOptions.requirements),
      "gatekeeper-assess": appleCertificatePrefixes.find(it => identity!.name.startsWith(it)) != null
    }

    await this.adjustSignOptions(signOptions, masOptions)
    log.info({
      file: log.filePath(appPath),
      identityName: identity.name,
      identityHash: identity.hash,
    }, "signing")
    await this.doSign(signOptions)

    // https://github.com/electron-userland/electron-builder/issues/1196#issuecomment-312310209
    if (masOptions != null && !isDevelopment) {
      const certType = isDevelopment ? "Mac Developer" : "3rd Party Mac Developer Installer"
      const masInstallerIdentity = await findIdentity(certType, masOptions.identity, keychainName)
      if (masInstallerIdentity == null) {
        throw new InvalidConfigurationError(`Cannot find valid "${certType}" identity to sign MAS installer, please see https://electron.build/code-signing`)
      }

      const artifactName = this.expandArtifactNamePattern(masOptions, "pkg")
      const artifactPath = path.join(outDir!, artifactName)
      await this.doFlat(appPath, artifactPath, masInstallerIdentity, keychainName)
      this.dispatchArtifactCreated(artifactPath, null, Arch.x64, this.computeSafeArtifactName(artifactName, "pkg"))
    }
  }

  private async adjustSignOptions(signOptions: any, masOptions: MasConfiguration | null) {
    const resourceList = await this.resourceList
    if (resourceList.includes(`entitlements.osx.plist`)) {
      throw new InvalidConfigurationError("entitlements.osx.plist is deprecated name, please use entitlements.mac.plist")
    }
    if (resourceList.includes(`entitlements.osx.inherit.plist`)) {
      throw new InvalidConfigurationError("entitlements.osx.inherit.plist is deprecated name, please use entitlements.mac.inherit.plist")
    }

    const customSignOptions = masOptions || this.platformSpecificBuildOptions
    const entitlementsSuffix = masOptions == null ? "mac" : "mas"
    if (customSignOptions.entitlements == null) {
      const p = `entitlements.${entitlementsSuffix}.plist`
      if (resourceList.includes(p)) {
        signOptions.entitlements = path.join(this.info.buildResourcesDir, p)
      }
    }
    else {
      signOptions.entitlements = customSignOptions.entitlements
    }

    if (customSignOptions.entitlementsInherit == null) {
      const p = `entitlements.${entitlementsSuffix}.inherit.plist`
      if (resourceList.includes(p)) {
        signOptions["entitlements-inherit"] = path.join(this.info.buildResourcesDir, p)
      }
    }
    else {
      signOptions["entitlements-inherit"] = customSignOptions.entitlementsInherit
    }
  }

  //noinspection JSMethodCanBeStatic
  protected async doSign(opts: SignOptions): Promise<any> {
    return signAsync(opts)
  }

  //noinspection JSMethodCanBeStatic
  protected async doFlat(appPath: string, outFile: string, identity: Identity, keychain: string | null | undefined): Promise<any> {
    // productbuild doesn't created directory for out file
    await ensureDir(path.dirname(outFile))

    const args = prepareProductBuildArgs(identity, keychain)
    args.push("--component", appPath, "/Applications")
    args.push(outFile)
    return await exec("productbuild", args)
  }

  public getElectronSrcDir(dist: string) {
    return path.resolve(this.projectDir, dist, this.electronDistMacOsAppName)
  }

  public getElectronDestinationDir(appOutDir: string) {
    return path.join(appOutDir, this.electronDistMacOsAppName)
  }

  protected async beforeCopyExtraFiles(appOutDir: string, asarIntegrity: AsarIntegrity | null): Promise<any> {
    await createMacApp(this, appOutDir, asarIntegrity)

    const wantedLanguages = asArray(this.platformSpecificBuildOptions.electronLanguages)
    if (wantedLanguages.length === 0) {
      return
    }

    // noinspection SpellCheckingInspection
    const langFileExt = ".lproj"
    const resourcesDir = this.getResourcesDir(appOutDir)
    await BluebirdPromise.map(readdir(resourcesDir), file => {
      if (!file.endsWith(langFileExt)) {
        return
      }

      const language = file.substring(0, file.length - langFileExt.length)
      if (!wantedLanguages.includes(language)) {
        return remove(path.join(resourcesDir, file))
      }
      return
    }, CONCURRENCY)
  }
}

function getCertificateType(isMas: boolean, isDevelopment: boolean): CertType {
  if (isDevelopment) {
    return "Mac Developer"
  }
  return isMas ? "3rd Party Mac Developer Application" : "Developer ID Application"
}