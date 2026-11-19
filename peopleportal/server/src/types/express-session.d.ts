
import 'express-session';
import { AuthorizedUser } from '../clients/OpenIdClient';

declare module 'express-session' {
  interface SessionData {
    authorizedUser?: AuthorizedUser;
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    tokenExpiry?: number;
    oidcState?: string;
    state?: string;

    /* OTP Auth (Temporary Sessions) */
    tempsession?: {
      otp?: string;
      otpEmail?: string;
      otpName?: string;
      otpExpiry?: number;
      jwt?: string;
      user?: {
        email: string,
        name: string,
        id: string,
      }

      /* Redirect Logic */
      return_to?: string;
      redirect_uri?: string;
      state?: string;
    }
  }
}
