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
import { fileConfiguration } from "@zxteam/configuration";
import { CancelledError } from "@zxteam/errors";
import { logger } from "@zxteam/logger";

import * as fs from "fs";
import * as util from "util";

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

const readFile = util.promisify(fs.readFile);


export interface Runtime {
	destroy(): Promise<void>;
}

export type ConfigurationFactory<T> = (cancellationToken: CancellationToken) => Promise<T>;

export type RuntimeFactory<T> = (cancellationToken: CancellationToken, configuration: T) => Promise<Runtime>;

export function launcher<T>(runtimeFactory: RuntimeFactory<T>): void;
export function launcher<T>(configurationFactory: ConfigurationFactory<T>, runtimeFactory: RuntimeFactory<T>): void;

export function launcher<T>(...args: Array<any>): void {
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

		let configurationFactory: ConfigurationFactory<T>;
		let runtimeFactory: RuntimeFactory<T>;
		if (args.length === 1 && typeof args[0] === "function") {
			configurationFactory = jsonConfigurationFactory;
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

export function jsonConfigurationFactory(): Promise<any> {
	return Promise.resolve().then(async () => {
		const configFileArg = process.argv.find(w => w.startsWith("--config="));
		if (configFileArg !== undefined) {
			const configFile = configFileArg.substring(9); // Cut --config=
			const configFileData = await readFile(configFile);
			const configuration = JSON.parse(configFileData.toString());
			return configuration;
		}
		throw new LaunchError("An argument --config is not passed");
	});
}

export function fileConfigurationFactory<T>(parser: (configuration: Configuration) => T): Promise<T> {
	return Promise.resolve().then(() => {
		const configFileArg = process.argv.find(w => w.startsWith("--config="));
		if (configFileArg !== undefined) {
			const configFile = configFileArg.substring(9); // Cut --config=
			return parser(fileConfiguration(configFile));
		}
		throw new LaunchError("An argument --config is not passed");
	});
}

export default launcher;

export class LaunchError extends Error { }
