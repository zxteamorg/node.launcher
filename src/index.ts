const { name: packageName, version: packageVersion } = require("../package.json");
const G: any = global || window || {};
const PACKAGE_GUARD: symbol = Symbol.for(packageName);
if (PACKAGE_GUARD in G) {
	const conflictVersion = G[PACKAGE_GUARD];
	// tslint:disable-next-line: max-line-length
	const msg = `Conflict module version. Look like two different version of package ${packageName} was loaded inside the process: ${conflictVersion} and ${packageVersion}.`;
	if (process !== undefined && process.env !== undefined && process.env.NODE_ALLOW_CONFLICT_MODULES === "1") {
		console.warn(msg + " This treats as warning because NODE_ALLOW_CONFLICT_MODULES is set.");
	} else {
		throw new Error(msg + " Use NODE_ALLOW_CONFLICT_MODULES=\"1\" to treats this error as warning.");
	}
} else {
	G[PACKAGE_GUARD] = packageVersion;
}

import { CancellationToken, Configuration } from "@zxteam/contract";
import { ManualCancellationTokenSource, CancellationTokenSource } from "@zxteam/cancellation";
import { fileConfiguration, chainConfiguration, envConfiguration, secretsDirectoryConfiguration } from "@zxteam/configuration";
import { CancelledError } from "@zxteam/errors";
import { logger } from "@zxteam/logger";

import { Provided as ProvidedOrig } from "typescript-ioc";

/*
	This module provides a facade for IoC functionality.
	Currently we use https://www.npmjs.com/package/typescript-ioc
		but we may change IoC library in future.
	[!] The application should not import "typescript-ioc" directly
*/
export { AutoWired, Container, Inject, Provides, Singleton } from "typescript-ioc";
export function Provided<T>(provider: Provider<T>): (target: Function) => void {
	return ProvidedOrig(provider);
}
export interface Provider<T> { get(): T; }

export interface Runtime {
	destroy(): Promise<void>;
}

export type ConfigurationFactory = (cancellationToken: CancellationToken) => Promise<Configuration>;
export type RuntimeFactory = (cancellationToken: CancellationToken, rawConfiguration: Configuration) => Promise<Runtime>;

export function launcher(runtimeFactory: RuntimeFactory): void;
export function launcher(configurationFactory: ConfigurationFactory, runtimeFactory: RuntimeFactory): void;
export function launcher(...args: Array<any>): void {
	const log = logger.getLogger("launcher");

	async function run() {
		let cancellationTokenSource: CancellationTokenSource = new ManualCancellationTokenSource();

		process.on("unhandledRejection", reason => {
			log.debug("Unhandled Rejection", reason);
			if (reason instanceof Error) {
				log.fatal(`Unhandled Rejection. ${reason.constructor.name}: ${reason.message}`);
			} else {
				log.fatal("Unhandled Rejection", reason);
			}
			process.exit(255);
		});

		let destroyRequestCount = 0;
		const shutdownSignals: Array<NodeJS.Signals> = ["SIGTERM", "SIGINT"];

		let configurationFactory: ConfigurationFactory;
		let runtimeFactory: RuntimeFactory;
		if (args.length === 1 && typeof args[0] === "function") {
			configurationFactory = defaultConfigurationFactory;
			runtimeFactory = args[0];
		} else if (args.length === 2 && typeof args[0] === "function" && typeof args[1] === "function") {
			configurationFactory = args[0];
			runtimeFactory = args[1];
		} else {
			throw new Error("Wrong arguments");
		}

		let runtime: Runtime;

		try {
			const configuration = await configurationFactory(cancellationTokenSource.token);
			runtime = await runtimeFactory(cancellationTokenSource.token, configuration);

			shutdownSignals.forEach((signal: NodeJS.Signals) => process.on(signal, () => gracefulShutdown(signal)));

		} catch (e) {
			if (e instanceof CancelledError) {
				log.warn("Runtime initialization was cancelled by user");
				process.exit(0);
			}
			if (log.isFatalEnabled) {
				if (e instanceof Error) {
					log.fatal(`Runtime initialization failed with ${e.constructor.name}: ${e.message}`);
				} else {
					log.fatal(`Runtime initialization failed with error: ${e}`);
				}
			}
			log.debug("Runtime initialization failed", e);
			process.exit(127);
		}

		async function gracefulShutdown(signal: string) {
			if (destroyRequestCount++ === 0) {
				cancellationTokenSource.cancel();

				if (log.isInfoEnabled) {
					log.info(`Interrupt signal received: ${signal}`);
				}
				await runtime.destroy();
				process.exit(0);
			} else {
				if (log.isInfoEnabled) {
					log.info(`Interrupt signal (${destroyRequestCount}) received: ${signal}`);
				}
			}
		}
	}

	log.info("Starting application...");
	run()
		.then(() => {
			if (log.isInfoEnabled) {
				log.info(`Application was started. Process ID: ${process.pid}`);
			}
		})
		.catch(reason => {
			if (log.isFatalEnabled) {
				if (reason instanceof LaunchError) {
					log.fatal(`Cannot launch the application due an ${reason.constructor.name}: ${reason.message}`);
				} else {
					log.fatal(reason.message, reason);
				}
			}
			if (process.env.NODE_ENV === "development") {
				setTimeout(() => process.exit(127), 1000);
			} else {
				process.exit(127);
			}
		});
}

export async function defaultConfigurationFactory(cancellationToken: CancellationToken): Promise<Configuration> {
	const configFiles: Array<string> = process.argv
		.filter(w => w.startsWith(defaultConfigurationFactory.CONFIG_FILE_ARG))
		.map(arg => /* trim start */arg.substring(defaultConfigurationFactory.CONFIG_FILE_ARG.length))
		.reverse();

	const secretsDirs: Array<string> = process.argv
		.filter(w => w.startsWith(defaultConfigurationFactory.CONFIG_SECRET_DIR_ARG))
		.map(arg => /* trim start */arg.substring(defaultConfigurationFactory.CONFIG_SECRET_DIR_ARG.length))
		.reverse();

	const chainItems: Array<Configuration> = [];

	// ENV variables have maximal priority
	const envConf = envConfiguration();
	chainItems.push(envConf);

	// Secret directories have secondary priority
	for (const secretsDir of secretsDirs) {
		const secretsConfiguration = await secretsDirectoryConfiguration(secretsDir);
		chainItems.push(secretsConfiguration);
	}

	// Config files variables have minimal priority
	for (const configFile of configFiles) {
		const fileConf: Configuration = await fileConfiguration(configFile);
		chainItems.push(fileConf);
	}

	const rawConfiguration: Configuration = chainConfiguration(...chainItems);

	return rawConfiguration;
}
export namespace defaultConfigurationFactory {
	export const CONFIG_FILE_ARG = "--config-file=";
	export const CONFIG_SECRET_DIR_ARG = "--config-secrets-dir=";
}

export default launcher;

export class LaunchError extends Error { }
