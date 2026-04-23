import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AccountsModule } from './accounts/accounts.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { config } from './config';
import { CopyModule } from './copy/copy.module';
import { BillingModule } from './billing/billing.module';

const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseConnectionUrl = (value: string | undefined) => {
  if (!value) return null;
  try {
    return new URL(value);
  } catch (e) {
    return null;
  }
};

const mysqlUrl =
  parseConnectionUrl(process.env.MYSQL_URL) ||
  parseConnectionUrl(process.env.DATABASE_URL);

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [config] }),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host:
        process.env.MYSQLHOST ||
        process.env.DB_HOST ||
        mysqlUrl?.hostname ||
        'localhost',
      port: toNumber(
        process.env.MYSQLPORT ||
          process.env.DB_PORT ||
          (mysqlUrl?.port ? mysqlUrl.port : undefined),
        3306,
      ),
      username:
        process.env.MYSQLUSER ||
        process.env.DB_USER ||
        (mysqlUrl?.username
          ? decodeURIComponent(mysqlUrl.username)
          : undefined) ||
        'root',
      password:
        process.env.MYSQLPASSWORD ||
        process.env.DB_PASSWORD ||
        (mysqlUrl?.password
          ? decodeURIComponent(mysqlUrl.password)
          : undefined) ||
        'example',
      database:
        process.env.MYSQLDATABASE ||
        process.env.DB_NAME ||
        (mysqlUrl?.pathname ? mysqlUrl.pathname.replace(/^\//, '') : undefined) ||
        'database',
      autoLoadEntities: true,
      synchronize: true,
    }),
    AccountsModule,
    AuthModule,
    CopyModule,
    BillingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
