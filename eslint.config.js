import antfu from '@antfu/eslint-config'

export default antfu([
  {
    markdown: true,
    rules: {
      'import/order': false,
    },
  },
  {
    unocss: false,
    formatters: true,
    markdwn: false,
    rules: {
      'import/order': [
        'error',
        {
          'groups': [
            ['type'],
            ['builtin', 'external'],
            ['parent', 'sibling', 'index'],
          ],
          'newlines-between': 'always',
        },
      ],
    },
  },
])
