import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER as string,
    pass: process.env.GMAIL_APP_PASSWORD as string
  }
})

export default transporter