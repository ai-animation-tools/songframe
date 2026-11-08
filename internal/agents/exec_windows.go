package agents

// canExecute вызывается только для платформ, отличных от win32; приложение под Windows
// всегда передаёт win32, поэтому права файла здесь не проверяются.
func canExecute(string) bool { return true }
