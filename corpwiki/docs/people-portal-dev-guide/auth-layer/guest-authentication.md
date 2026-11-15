---
sidebar_position: 3
---

# Guest Authentication

The People Portal provides a specialized authentication mechanism for non-organization members (guests), primarily for the Recruitment/ATS module. This system uses a time-based One-Time Password (OTP) sent via email to establish a temporary, semi-persistent session.

## Architecture & Flow

The Guest Authentication does **not** use OIDC. Instead, it relies on a custom implementation backed by `express-session`, the custom `tempsession` object and signed JWTs.

### Authentication Sequence

```mermaid
sequenceDiagram
    participant Guest as Guest User
    participant Server as AuthController
    participant Email as EmailClient
    participant Store as Session Store (Redis/Memory)
    participant Auth as Security Middleware

    Note over Guest, Store: Phase 1: Initiation
    Guest->>Server: POST /auth/otpinit (email, name)
    Server->>Server: Generate 6-digit OTP
    Server->>Store: Store in tempsession<br/>{ otp, email, name, expiry }
    Server->>Email: Send "AuthOtpSendCode" Template
    Email-->>Guest: Email with Code

    Note over Guest, Store: Phase 2: Verification
    Guest->>Server: POST /auth/otpverify (email, otp)
    Server->>Store: Retrieve tempsession

    alt Invalid OTP or Expired
        Server-->>Guest: 401 Unauthorized
    else Valid OTP
        Server->>Server: Create/Get "Applicant" from DB
        Server->>Server: Sign Session JWT (24h)
        Server->>Store: Update tempsession<br/>{ jwt, user: { email, name, id } }
        Server-->>Guest: 200 OK (Profile Data)
    end

    Note over Guest, Store: Phase 3: Protected Resources
    Guest->>Server: GET /api/ats/applications

    rect rgba(150, 100, 255, 0.1)
        note right of Auth: @Security("ats_otp")
        Auth->>Store: Check tempsession.jwt
        Auth->>Auth: Verify JWT Signature
        alt Valid
            Auth-->>Server: Allow Access
        else Invalid
            Auth-->>Guest: 401 Unauthorized
        end
    end
```

## Internal Storage (`tempsession`)

Guest sessions are isolated from the main OIDC `authorizedUser` sessions. They are stored in a dedicated object within the session cookie called `tempsession`.

### Initiation State

During the OTP verification phase (before the user enters the code), the session holds the secret:

```js
req.session.tempsession = {
  otp: "123456",
  otpEmail: "guest@example.com",
  otpName: "John Doe",
  otpExpiry: 1735689600000, // Date.now() + 5 mins
};
```

### Authenticated State

Once verified, the sensitive OTP data is discarded, and the session maps the user to a signed JWT. This JWT acts as the "Bearer" token for the internal API, even though it's stored in the cookie.

```js
req.session.tempsession = {
  jwt: "eyJhbGciOiJIUzI1NiIsIn...", // Signed 24h JWT
  user: {
    email: "guest@example.com",
    name: "John Does",
    id: "60d5ec...", // Mongo Object ID
  },
};
```

## Security Middleware (`ats_otp`)

Endpoints protected by `@Security("ats_otp")` trigger the specific logic in `auth.ts`:

1.  **Existence Check**: Ensures `req.session.tempsession.jwt` exists.
2.  **Verification**: Cryptographically verifies the JWT using `PEOPLEPORTAL_TOKEN_SECRET`.
3.  **Expiry Handling**: If the JWT is expired, the session is cleared, and the user is forced to re-authenticate.

## Applicant Profile

Upon successful verification, if the email does not exist in the `Applicant` database collection, a new profile is automatically created. This "Just-In-Time" provisioning allows guests to immediately start applying for roles without a registration form.
