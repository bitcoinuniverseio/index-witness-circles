import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { configuration } from '../config/configuration';
import { databaseOptions } from './options';

const AppDataSource = new DataSource(databaseOptions(configuration()));

export default AppDataSource;
