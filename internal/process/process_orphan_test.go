//go:build linux || windows

package process

import (
	"bufio"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestChildDiesWithKilledParent проверяет главное свойство привязки к приложению: после
// аварийного завершения родителя (Kill без возможности убрать за собой) программа, запущенная
// им через Run, не остаётся работать сиротой.
func TestChildDiesWithKilledParent(t *testing.T) {
	parent := newCommand(helper("orphan-parent"))
	stdout, err := parent.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	defer parent.Wait()
	lines := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		lines <- line
	}()
	var child int
	select {
	case line := <-lines:
		child, err = strconv.Atoi(strings.TrimSpace(line))
		if err != nil {
			parent.Process.Kill()
			t.Fatalf("pid программы: %q", line)
		}
	case <-time.After(10 * time.Second):
		parent.Process.Kill()
		t.Fatal("родитель не сообщил pid программы")
	}
	if childGone(child) {
		t.Fatal("программа завершилась раньше родителя")
	}
	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !childGone(child) {
		if time.Now().After(deadline) {
			killPid(child)
			t.Fatalf("программа %d пережила аварийное завершение родителя", child)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
