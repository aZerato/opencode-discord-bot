import qrcode from 'qrcode';
import { authenticator } from 'otplib';

/**
 * Script CLI : génère un secret TOTP via `authenticator.generateSecret()`,
 * construit l'URI `otpauth://totp/OpenCode:Admin?secret=…&issuer=OpenCode`,
 * affiche le QR Code dans le terminal et le secret à copier dans le `.env`.
 *
 * Exécution : `npm run setup:otp`
 */
async function main(): Promise<void> {
  const secret = authenticator.generateSecret();
  const uri = `otpauth://totp/OpenCode:Admin?secret=${secret}&issuer=OpenCode`;

  console.log('=== OpenCode Discord Bot — Initialisation OTP ===');
  console.log(
    "Scannez le QR Code ci-dessous avec Microsoft Authenticator / Google Authenticator.",
  );
  console.log();
  const qr = await qrcode.toString(uri, { type: 'terminal' });
  console.log(qr);
  console.log();
  console.log(`URI : ${uri}`);
  console.log();
  console.log('Puis, dans votre `.env`, ajoutez :');
  console.log(`OTP_SECRET=${secret}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
