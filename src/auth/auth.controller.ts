import { All, Controller, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthCallbackQuery } from 'src/interfaces/auth-callback-query.interface';
import { AuthService } from './auth.service';
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @All('/callback')
  async callback(
    @Query()
    query: AuthCallbackQuery,
    @Res() res: Response,
  ) {
    return res.redirect(await this.authService.performCallBack(query));
  }
}
