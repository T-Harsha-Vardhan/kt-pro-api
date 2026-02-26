import crypto from 'crypto'

const generateOTP = (): string => {
  return crypto.randomInt(100000, 999999).toString()
}

export default generateOTP