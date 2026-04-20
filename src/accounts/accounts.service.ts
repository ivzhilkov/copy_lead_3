import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosInstance } from 'axios';
import { AuthService } from 'src/auth/auth.service';
import { GrantTypes } from 'src/enums/grant-types.enum';
import { Repository } from 'typeorm';
import { Account } from './account.entity';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private readonly accountsRepo: Repository<Account>,
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
  ) {}

  findByAmoId(amoId: number): Promise<Account> {
    return this.accountsRepo.findOne({ amoId });
  }
  create(data: Partial<Account>): Promise<Account> {
    return this.accountsRepo.save(data);
  }

  async update(id: number, data: Partial<Account>): Promise<Account> {
    await this.accountsRepo.save({ ...data, id });
    return this.accountsRepo.findOne(id);
  }
  createConnector(amoId: number): AxiosInstance {
    // console.log(amoId);
    const api = axios.create();
    let account: Account;
    api.interceptors.request.use(
      async (config) => {
        if (!account) {
          account = await this.findByAmoId(amoId);
        }
        const { oauth } = account;
        if (oauth.expire - 60 * 1000 < Number(new Date())) {
          account = await this.update(account.id, {
            oauth: await this.authService.getNewTokens(
              oauth.refreshToken,
              account.domain,
              GrantTypes.RefreshToken,
            ),
          });
        }
        config.baseURL = account.url;
        config.headers.Authorization = `Bearer ${account.oauth.accessToken}`;
        return config;
      },
      (e) => Promise.reject(e),
    );
    return api;
  }
}
