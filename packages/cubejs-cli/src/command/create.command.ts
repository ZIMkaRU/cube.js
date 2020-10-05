import fs from 'fs-extra';
import chalk from 'chalk';
import crypto from 'crypto';
import path from 'path';
import inquirer from 'inquirer';

import { CommandInterface } from './command.interface';
import { displayError, event, requireFromPackage } from '../utils';
import { logStage } from '../logger';
import { executeCommand, npmInstall, writePackageJson } from '../packages';
import templates from '../templates';
import { CommanderStatic } from 'commander';

export class CreateCommand implements CommandInterface {
  public configure(program: CommanderStatic) {
    return program
      .command('create <name>')
      .option(
        '-d, --db-type <db-type>',
        'Preconfigure for selected database.\n\t\t\t     ' +
        'Options: postgres, mysql, mongobi, athena, redshift, bigquery, mssql, clickhouse, snowflake, presto'
      )
      .option('-t, --template <template>', 'App template. Options: express (default), serverless.')
      .description('Create new Cube.js app')
      .action(
        (projectName, options) => this.execute(projectName, options)
          .catch(e => displayError(e.stack || e, { projectName, dbType: options.dbType }))
      )
      .on('--help', () => {
        console.log('');
        console.log('Examples:');
        console.log('');
        console.log('  $ cubejs create hello-world -d postgres');
      })
  }

  public async execute(projectName: string, options: { template?: string, dbType?: string, })
  {
    const template = options.template || 'express';
    const createAppOptions = { projectName, dbType: options.dbType, template };

    event('Create App', createAppOptions);

    if (await fs.pathExists(projectName)) {
      await displayError(
        `We cannot create a project called ${chalk.green(
          projectName
        )}: directory already exist.\n`,
        createAppOptions
      );
    }
    if (!templates[template]) {
      await displayError(
        `Unknown template ${chalk.red(template)}`,
        createAppOptions
      );
    }

    await fs.ensureDir(projectName);
    process.chdir(projectName);

    const templateConfig = templates[template];

    logStage('Creating project structure');
    await writePackageJson({
      name: projectName,
      version: '0.0.1',
      private: true,
      scripts: templateConfig.scripts,
    });

    logStage('Installing server dependencies');
    await npmInstall(['@cubejs-backend/server']);

    if (!options.dbType) {
      const Drivers = await requireFromPackage('@cubejs-backend/server-core/core/DriverDependencies.js');
      const prompt = await inquirer.prompt([{
        type: 'list',
        name: 'dbType',
        message: 'Select database',
        choices: Object.keys(Drivers)
      }]);

      options.dbType = prompt.dbType;
    }

    logStage('Installing DB driver dependencies');
    const CubejsServer = await requireFromPackage('@cubejs-backend/server');
    let driverDependencies = CubejsServer.driverDependencies(options.dbType);
    if (!driverDependencies) {
      await displayError(`Unsupported db type: ${chalk.green(options.dbType)}`, createAppOptions);
    }
    driverDependencies = Array.isArray(driverDependencies) ? driverDependencies : [driverDependencies];
    if (driverDependencies[0] === '@cubejs-backend/jdbc-driver') {
      driverDependencies.push('node-java-maven');
    }
    await npmInstall(driverDependencies);

    if (driverDependencies[0] === '@cubejs-backend/jdbc-driver') {
      logStage('Installing JDBC dependencies');
      const JDBCDriver = require(path.join(process.cwd(), 'node_modules', '@cubejs-backend', 'jdbc-driver', 'driver', 'JDBCDriver'));
      const dbTypeDescription = JDBCDriver.dbTypeDescription(options.dbType);
      if (!dbTypeDescription) {
        await displayError(`Unsupported db type: ${chalk.green(options.dbType)}`, createAppOptions);
      }

      const newPackageJson = await fs.readJson('package.json');
      if (dbTypeDescription.mavenDependency) {
        newPackageJson.java = {
          dependencies: [dbTypeDescription.mavenDependency]
        };
      }
      newPackageJson.scripts = newPackageJson.scripts || {};
      newPackageJson.scripts.install = './node_modules/.bin/node-java-maven';
      await writePackageJson(newPackageJson);

      await executeCommand('npm', ['install']);
    }

    logStage('Writing files from template');

    const driverClass = await requireFromPackage(driverDependencies[0]);

    const env = {
      dbType: options.dbType,
      apiSecret: crypto.randomBytes(64).toString('hex'),
      projectName,
      driverEnvVariables: driverClass.driverEnvVariables && driverClass.driverEnvVariables()
    };
    await Promise.all(Object.keys(templateConfig.files).map(async fileName => {
      await fs.ensureDir(path.dirname(fileName));
      await fs.writeFile(fileName, templateConfig.files[fileName](env));
    }));

    if (templateConfig.dependencies) {
      logStage('Installing template dependencies');
      await npmInstall(templateConfig.dependencies);
    }

    if (templateConfig.devDependencies) {
      logStage('Installing template dev dependencies');
      await npmInstall(templateConfig.devDependencies);
    }

    await event('Create App Success', { projectName, dbType: options.dbType });
    logStage(`${chalk.green(projectName)} app has been created 🎉`);

    console.log();
    console.log('📊 Next step: run dev server');
    console.log();
    console.log(`     $ cd ${projectName}`);
    console.log('     $ npm run dev');
    console.log();
  }
}
