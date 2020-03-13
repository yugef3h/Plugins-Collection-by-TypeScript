import path from "path";
import { sync as delSync } from "del";
import { Compiler, Stats, compilation as compilationType } from "webpack";

type Compilation = compilationType.Compilation;

export interface Options {
  dry?: boolean; // 模拟文件删除 default: false
  verbose?: boolean; // 打印，依赖 dry default: false
  cleanStaleWebpackAssets?: boolean; // default: true
  protectWebpackAssets?: boolean; // Do not allow removal of current webpack assets
  cleanOnceBeforeBuildPatterns?: string[]; // 在Webpack编译之前删除文件一次，可以使用正则 default: ['**\/*']
  cleanAfterEveryBuildPatterns?: string[]; // default: []
  dangerouslyAllowCleanPatternsOutsideProject?: boolean; // 是否开启删除 patterns outside of process.cwd()
}
function isPlainObject(value: unknown): boolean {
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.getPrototypeOf({});
}

class CleanWebpackPlugin {
  private readonly dry: boolean;
  private readonly verbose: boolean;
  private readonly cleanStaleWebpackAssets: boolean;
  private readonly protectWebpackAssets: boolean;
  private readonly cleanAfterEveryBuildPatterns: string[];
  private readonly cleanOnceBeforeBuildPatterns: string[];
  private readonly dangerouslyAllowCleanPatternsOutsideProject: boolean;
  private currentAssets: string[];
  private initialClean: boolean;
  private outputPath: string;

  constructor(options: Options = {}) {
    if (isPlainObject(options) === false)
      throw new Error(`clean-webpack-plugin only accepts an options object`);

    if (
      options.dangerouslyAllowCleanPatternsOutsideProject === true &&
      options.dry !== true &&
      options.dry !== false
    ) {
      console.warn(
        "当 dangerouslyAllowCleanPatternsOutsideProject 开启时，dry 需要明确定义为 false，开启 dry 模式"
      );
    }

    this.dangerouslyAllowCleanPatternsOutsideProject =
      options.dangerouslyAllowCleanPatternsOutsideProject === true || false;
    this.dry =
      options.dry === true || options.dry === false
        ? options.dry
        : this.dangerouslyAllowCleanPatternsOutsideProject === true || false;

    this.verbose = this.dry === true || options.verbose === true || false;

    this.cleanStaleWebpackAssets =
      options.cleanStaleWebpackAssets === true ||
      options.cleanStaleWebpackAssets === false
        ? options.cleanStaleWebpackAssets
        : true;

    this.protectWebpackAssets =
      options.protectWebpackAssets === true ||
      options.protectWebpackAssets === false
        ? options.protectWebpackAssets
        : true;

    this.cleanAfterEveryBuildPatterns = Array.isArray(
      options.cleanAfterEveryBuildPatterns
    )
      ? options.cleanAfterEveryBuildPatterns
      : [];

    this.cleanOnceBeforeBuildPatterns = Array.isArray(
      options.cleanOnceBeforeBuildPatterns
    )
      ? options.cleanOnceBeforeBuildPatterns
      : ["**/*"];

    this.currentAssets = [];
    this.initialClean = false;
    this.outputPath = "";

    this.apply = this.apply.bind(this);
    this.handleInitial = this.handleInitial.bind(this);
    this.handleDone = this.handleDone.bind(this);
    this.removeFiles = this.removeFiles.bind(this);
  }

  apply(compiler: Compiler) {
    if (!compiler.options.output || !compiler.options.output.path) {
      console.warn("options.output.path not defined. Plugin disabled...");
      return;
    }
    this.outputPath = compiler.options.output.path;
    const hooks = compiler.hooks;
    if (this.cleanOnceBeforeBuildPatterns.length !== 0) {
      if (hooks) {
        hooks.emit.tap("clean-webpack-plugin", (compilation) => {
          this.handleInitial(compilation);
        });
      } else {
        compiler.plugin("emit", (compilation, callback) => {
          try {
            this.handleInitial(compilation);

            callback();
          } catch (error) {
            callback(error);
          }
        });
      }
    }

    if (hooks) {
      hooks.done.tap("clean-webpack-plugin", (stats) => {
        this.handleDone(stats);
      });
    } else {
      compiler.plugin("done", (stats) => {
        this.handleDone(stats);
      });
    }
  }
  handleInitial(compilation: Compilation) {
    if (this.initialClean) {
      return;
    }

    /**
     * 发生错误则不删除
     */
    const stats = compilation.getStats();
    if (stats.hasErrors()) {
      return;
    }

    this.initialClean = true;

    this.removeFiles(this.cleanOnceBeforeBuildPatterns);
  }
  handleDone(stats: Stats) {
    if (stats.hasErrors()) {
      if (this.verbose) {
        // eslint-disable-next-line no-console
        console.warn("clean-webpack-plugin: pausing due to webpack errors");
      }

      return;
    }
    // 输出
    const assets =
      stats.toJson(
        {
          assets: true,
        },
        true
      ).assets || [];
    const assetList = assets.map((asset: { name: string }) => {
      return asset.name;
    });
    // 获取构建前的文件
    const staleFiles = this.currentAssets.filter((previousAsset) => {
      const assetCurrent = assetList.includes(previousAsset) === false;

      return assetCurrent;
    });
    // 构建后
    this.currentAssets = assetList.sort();
    // 无用的删除
    const removePatterns = [];
    if (this.cleanStaleWebpackAssets === true && staleFiles.length !== 0) {
      removePatterns.push(...staleFiles);
    }
    if (this.cleanAfterEveryBuildPatterns.length !== 0) {
      removePatterns.push(...this.cleanAfterEveryBuildPatterns);
    }
    if (removePatterns.length !== 0) {
      this.removeFiles(removePatterns);
    }
  }
  removeFiles(patterns: string[]) {
    try {
      const deleted = delSync(patterns, {
        force: this.dangerouslyAllowCleanPatternsOutsideProject,
        // Change context to build directory
        cwd: this.outputPath,
        dryRun: this.dry,
        dot: true,
        ignore: this.protectWebpackAssets ? this.currentAssets : [],
      });

      /**
       * Log if verbose is enabled
       */
      if (this.verbose) {
        deleted.forEach(file => {
          const filename = path.relative(process.cwd(), file);

          const message = this.dry ? "dry" : "removed";

          /**
           * Use console.warn over .log
           * https://github.com/webpack/webpack/issues/1904
           * https://github.com/johnagan/clean-webpack-plugin/issues/11
           */
          // eslint-disable-next-line no-console
          console.warn(`clean-webpack-plugin: ${message} ${filename}`);
        });
      }
    } catch (error) {
      const needsForce = /Cannot delete files\/folders outside the current working directory\./.test(
        error.message
      );

      if (needsForce) {
        const message =
          "clean-webpack-plugin: Cannot delete files/folders outside the current working directory. Can be overridden with the `dangerouslyAllowCleanPatternsOutsideProject` option.";

        throw new Error(message);
      }

      throw error;
    }
  }
}

export { CleanWebpackPlugin };
