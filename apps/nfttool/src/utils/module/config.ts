// import { ThemingProps } from '@chakra-ui/react'

export const SITE_NAME = 'NFTTOOL'
export const SITE_DESCRIPTION = 'NFT MINT ETH TOOL 脚本工具 撸毛'
export const SITE_URL = 'https://www.nfttool.club'
export const SITE_URL_NEED_CHANGE = 'https://nfttool.club'

export const THEME_INITIAL_COLOR = 'system'
// export const THEME_COLOR_SCHEME: ThemingProps['colorScheme'] = 'gray'
// | "blue" | "cyan" | "gray" | "green" | "orange" | "pink" | "purple" | "red" | "teal" | "yellow" | "twitter" | "whiteAlpha" | "blackAlpha" | "linkedin" | "facebook" | "messenger" | "whatsapp" | "telegram"
export const THEME_CONFIG = {
  initialColorMode: THEME_INITIAL_COLOR,
}

export const SOCIAL_TWITTER = 'nfttool_club'
// export const SOCIAL_GITHUB = 'wslyvh/nexth'

export const infuraKey = '520b73eb580b494886af9ae9a348b88b'

export const SERVER_SESSION_SETTINGS = {
  cookieName: SITE_NAME,
  password: process.env.SESSION_PASSWORD ?? 'UPDATE_TO_complex_password_at_least_32_characters_long',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
  },
}
