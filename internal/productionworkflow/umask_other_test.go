//go:build !unix

package productionworkflow

import "testing"

// fixUmask — вне unix права файлов не соответствуют эталону, снятому в Linux: тест пропускается.
func fixUmask(t *testing.T) {
	t.Skip("права файлов эталона Apply сверяются только в unix")
}
